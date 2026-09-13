import { pageRevisionHeader } from "@comms/protocol/headers";
import { BunCrypto } from "@effect/platform-bun";
import { Crypto, Effect, Stream } from "effect";
import type { Plugin, ProxyOptions } from "vite";

const scriptPath = "/__comms/page-reload.js";
// Served only by Vite's development middleware. The expected revision belongs to
// this document, not a shared cache, so an edit between load and first poll is seen.
const script = `(() => {
  const source = document.currentScript?.src;
  if (!source) return;
  const revision = new URL(source).searchParams.get("revision");
  const page = new URL(location.href);
  page.hash = "";
  let stopped = false;
  let generation = 0;
  let timer;
  window.addEventListener("pagehide", () => {
    stopped = true;
    generation++;
    clearTimeout(timer);
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    stopped = false;
    timer = setTimeout(poll, 1000);
  });
  async function poll() {
    if (stopped) return;
    const current = generation;
    try {
      const response = await fetch(page, {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "${pageRevisionHeader}": "1" }
      });
      if (stopped || current !== generation) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        stopped = true;
        location.reload();
        return;
      }
      const next = response.ok && response.headers.get("${pageRevisionHeader}") === "1"
        ? await response.text() : revision;
      if (stopped || current !== generation) return;
      if (next !== revision) {
        stopped = true;
        location.reload();
        return;
      }
    } catch { /* A restart or offline interval is retried without replacing the page. */ }
    if (!stopped && current === generation) timer = setTimeout(poll, 1000);
  }
  timer = setTimeout(poll, 1000);
})();`;

/** Vite is the development HTTP adapter. Every page/revision still passes through
 * boot with the original path and credentials; this code never reads page files. */
export const pageDevReload = (target: string): Plugin => ({
	name: "comms-page-dev-reload",
	apply: "serve",
	config: () => ({ server: { proxy: { "/p": pageDevProxy(target) } } }),
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			if (request.method !== "GET" || request.url?.split("?")[0] !== scriptPath) return next();
			response.writeHead(200, {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(script);
		});
	},
});

const pageDevProxy = (target: string): ProxyOptions => ({
	target,
	selfHandleResponse: true,
	configure(proxy) {
		proxy.on("proxyReq", (outgoing) => {
			// Hash the original bytes, independent of client compression/cache headers.
			outgoing.setHeader("accept-encoding", "identity");
			outgoing.removeHeader("if-none-match");
			outgoing.removeHeader("if-modified-since");
			outgoing.removeHeader(pageRevisionHeader);
		});
		proxy.on("proxyRes", (incoming, request, response) => {
			const headers = { ...incoming.headers };
			if (
				request.method !== "GET" ||
				incoming.statusCode !== 200 ||
				!headers["content-type"]?.startsWith("text/html") ||
				headers["content-encoding"]
			) {
				response.writeHead(incoming.statusCode ?? 502, headers);
				incoming.pipe(response);
				return;
			}
			const render = Effect.gen(function* () {
				const chunks = yield* Stream.fromAsyncIterable<unknown, "page_proxy_read_failed">(
					incoming,
					() => "page_proxy_read_failed",
				).pipe(
					Stream.mapEffect((chunk) =>
						chunk instanceof Uint8Array ? Effect.succeed(chunk) : Effect.fail("page_proxy_read_failed"),
					),
					Stream.runCollect,
				);
				const body = Buffer.concat(chunks);
				const crypto = yield* Crypto.Crypto;
				const revision = Buffer.from(yield* crypto.digest("SHA-256", body)).toString("hex");
				const polling = request.headers[pageRevisionHeader] === "1";
				const result = polling
					? revision
					: Buffer.concat([body, Buffer.from(`\n<script src="${scriptPath}?revision=${revision}"></script>`)]);
				delete headers["content-length"];
				delete headers["transfer-encoding"];
				delete headers.etag;
				headers["cache-control"] = "no-store";
				if (polling) {
					headers["content-type"] = "text/plain; charset=utf-8";
					headers[pageRevisionHeader] = "1";
				}
				response.writeHead(200, headers);
				response.end(result);
			}).pipe(
				Effect.provide(BunCrypto.layer),
				Effect.catchCause(() =>
					Effect.sync(() => {
						if (!response.headersSent) response.writeHead(502);
						response.end();
					}),
				),
			);
			void Effect.runPromise(render);
		});
	},
});
