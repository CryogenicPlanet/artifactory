import { Effect, Layer, Path } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

// Only these package-owned files are public; never serve a node_modules directory.
const assets = Object.freeze([
	["markdown.css", "github-markdown-css/github-markdown-light.css"],
	["highlight.css", "highlight.js/styles/github.min.css"],
	["mermaid.js", "mermaid/dist/mermaid.min.js"],
	["tailwind.js", "@tailwindcss/browser"],
] as const);
const headers = Object.freeze({
	"cache-control": "no-cache",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
});
export const routes = Layer.mergeAll(
	HttpRouter.add(
		"GET",
		"/page-assets/mermaid-init.js",
		Effect.succeed(
			HttpServerResponse.text("mermaid.initialize({startOnLoad:true,theme:'default',securityLevel:'strict'});", {
				contentType: "text/javascript; charset=utf-8",
				headers,
			}),
		),
	),
	...assets.map(([name, dependency]) =>
		HttpRouter.add(
			"GET",
			`/page-assets/${name}`,
			Effect.gen(function* () {
				const path = yield* Path.Path;
				const resolved = yield* Effect.try(() => import.meta.resolve(dependency));
				return yield* HttpServerResponse.file(yield* path.fromFileUrl(new URL(resolved)), {
					contentType: name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
					headers,
				});
			}).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503, headers })))),
		),
	),
);
