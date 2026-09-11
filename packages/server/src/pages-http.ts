import { Messages } from "./ext/core/messages.ts";
import { Cause, Effect, FileSystem, Layer, Option, Scope, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Mime } from "effect/unstable/http";
import { identity } from "./conversation-request.ts";
import { PageRejected, Pages } from "./ext/core/pages.ts";
import { escapeHtml, pageDocument, pageHref } from "./page-markdown.ts";
import { routes as assetRoutes } from "./page-assets.ts";

import { htmlHeaders as pageHeaders } from "./html-headers.ts";
import { pageFailure } from "./page-failure.ts";

const page = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const pages = yield* Pages;
	const requestScope = yield* Effect.scope;
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
	return yield* (yield* Messages).read((ceiling) =>
		Effect.gen(function* () {
			let selected = name;
			let target = yield* pages.resolve(name);
			if (
				anonymous &&
				!(yield* pages.publicTopic(
					target.type === "Directory" ? name : name.split("/").slice(0, -1).join("/"),
					ceiling,
				))
			)
				return yield* new PageRejected({ code: "page_not_found" });
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
			const fs = yield* FileSystem.FileSystem;
			// Open while the path and its public grant are protected. The request scope owns this descriptor, not the SQL snapshot.
			const file = yield* fs.open(target.absolute).pipe(Effect.provideService(Scope.Scope, requestScope));
			const info = yield* file.stat;
			const contentType = selected.toLowerCase().endsWith(".md")
				? "text/markdown; charset=utf-8"
				: Option.getOrElse(Mime.getType(selected), () => "application/octet-stream");
			if (request.method === "HEAD")
				return HttpServerResponse.empty({
					status: 200,
					headers: { ...pageHeaders, "content-type": contentType, "content-length": String(info.size) },
				});
			return HttpServerResponse.stream(
				Stream.fromPull(
					Effect.succeed(
						file
							.readAlloc(65536)
							.pipe(
								Effect.flatMap(
									Option.match({ onNone: () => Cause.done(), onSome: (bytes) => Effect.succeed([bytes]) }),
								),
							),
					),
				),
				{ headers: pageHeaders, contentType, contentLength: Number(info.size) },
			);
		}),
	);
}).pipe(pageFailure);
export const routes = Layer.mergeAll(HttpRouter.add("GET", "/p/*", page), assetRoutes);
