import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { identity } from "./conversation-request.ts";
import { PageRejected, Pages } from "./kernel/pages.ts";
import { escapeHtml, pageDocument, pageHref } from "./page-markdown.ts";
import { routes as assetRoutes } from "./page-assets.ts";

const pageHeaders = Object.freeze({
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
});

const page = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const pages = yield* Pages;
	const url = new URL(request.url, "http://localhost");
	const name = yield* Effect.try({
		try: () => decodeURIComponent(url.pathname.slice("/p".length).replace(/^\//, "").replace(/\/$/, "")),
		catch: () => new PageRejected({ code: "page_path_invalid" }),
	});
	const publicPage = yield* Effect.try(() => decodeURIComponent(request.headers["x-comms-public-page"] ?? "")).pipe(
		Effect.orElseSucceed(() => null),
	);
	const anonymous =
		request.headers["x-comms-public-page"] !== undefined &&
		publicPage === name &&
		(request.method === "GET" || request.method === "HEAD");
	if (!anonymous) yield* identity("read");
	let selected = name;
	let target = yield* pages.resolve(name);
	if (target.type === "Directory") {
		if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname}/${url.search}`);
		const entries = yield* pages.entries(name, anonymous);
		const index = ["index.md", "index.html"].find((entry) =>
			entries.some((file) => file.name === entry && !file.directory),
		);
		if (!index)
			return HttpServerResponse.text(
				pageDocument(
					name,
					`<h1>${escapeHtml(name || "Pages")}</h1><ul class="listing">${entries.map((entry) => `<li><a href="${escapeHtml(pageHref(name ? `${name}/${entry.name}` : entry.name))}${entry.directory ? "/" : ""}">${escapeHtml(entry.name)}${entry.directory ? "/" : ""}</a></li>`).join("")}</ul>`,
				),
				{ contentType: "text/html; charset=utf-8", headers: pageHeaders },
			);
		selected = name ? `${name}/${index}` : index;
		target = yield* pages.resolve(selected);
	}
	if (selected.toLowerCase().endsWith(".md") && url.searchParams.get("raw") !== "1")
		return HttpServerResponse.text(pages.render(yield* pages.read(selected), selected), {
			contentType: "text/html; charset=utf-8",
			headers: pageHeaders,
		});
	return yield* HttpServerResponse.file(target.absolute, {
		headers: pageHeaders,
		...(selected.toLowerCase().endsWith(".md") ? { contentType: "text/markdown; charset=utf-8" } : {}),
	});
}).pipe(
	Effect.catchTags({
		PageRejected: (error) =>
			Effect.succeed(
				HttpServerResponse.jsonUnsafe(
					{
						error: {
							code: error.code,
							message: "Page request failed.",
							hint: "Check the page path under /p/.",
							retriable: error.code === "pages_unavailable",
						},
					},
					{ status: error.code === "page_not_found" ? 404 : error.code === "page_path_invalid" ? 400 : 503 },
				),
			),
		KernelError: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
	}),
	Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
);
export const routes = Layer.mergeAll(HttpRouter.add("GET", "/p/*", page), assetRoutes);
