import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { boardRecovery } from "./board-recovery.ts";
import { identity } from "./conversation-request.ts";

/** Only built board files adjacent to this generation are served; never the editable tree. */
const board = (directory: string) =>
	Effect.gen(function* () {
		yield* identity("read");
		const request = yield* HttpServerRequest.HttpServerRequest;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const pathname = new URL(request.url, "http://localhost").pathname;
		const asset = pathname.startsWith("/assets/");
		const name = asset
			? yield* Effect.try(() => decodeURIComponent(pathname.slice(1))).pipe(Effect.orElseSucceed(() => ""))
			: "index.html";
		const parts = name.split("/");
		if (
			parts.some(
				(part) =>
					!part ||
					part.startsWith(".") ||
					part.includes("\\") ||
					part.includes(":") ||
					part.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
			)
		)
			return HttpServerResponse.empty({ status: 404 });
		const unavailable = () =>
			asset
				? HttpServerResponse.empty({ status: 404 })
				: HttpServerResponse.text(boardRecovery, {
						contentType: "text/html; charset=utf-8",
						status: 503,
						headers: { "cache-control": "no-store" },
					});
		if (!(yield* fs.exists(directory))) return unavailable();
		let target = directory;
		if ((yield* fs.realPath(target)) !== target) return unavailable();
		for (const part of parts) {
			target = path.join(target, part);
			if (!(yield* fs.exists(target)) || (yield* fs.realPath(target)) !== target) return unavailable();
		}
		if ((yield* fs.stat(target)).type !== "File") return unavailable();
		return yield* HttpServerResponse.file(target, {
			headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
		});
	}).pipe(
		Effect.catchTag("KernelError", () => Effect.succeed(HttpServerResponse.empty({ status: 403 }))),
		Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
	);

export const routes = (directory: string) =>
	Layer.mergeAll(
		HttpRouter.add("GET", "/", board(directory)),
		HttpRouter.add("GET", "/t/*", board(directory)),
		HttpRouter.add("GET", "/ext", board(directory)),
		HttpRouter.add("GET", "/@:agent", board(directory)),
		HttpRouter.add("GET", "/assets/*", board(directory)),
	);
