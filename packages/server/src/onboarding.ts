import { initHeader, initStaleHeader, initVersionHeader, scopesHeader } from "@comms/protocol/headers";
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";
import { Crypto, Effect, Layer, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { failure, identity } from "./conversation-request.ts";
import { liveDiscovery } from "./discovery.ts";
import { Pages } from "./ext/core/pages.ts";
import { escapeHtml } from "./page-markdown.ts";

/** Input-free manual routes contribute to the same assembled discovery document. */
export const description = HttpApiGroup.make("onboarding").add(
	HttpApiEndpoint.get("api", "/api", { success: Schema.Unknown }).annotate(
		OpenApi.Description,
		"Describe the assembled API, including loaded extensions and boot recovery routes. Requires read.",
	),
	HttpApiEndpoint.get("init", "/init", {
		success: [
			Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
			Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
		],
	}).annotate(
		OpenApi.Description,
		"Public editable orientation, served as Markdown or HTML according to Accept. Includes verified identity when authenticated.",
	),
	HttpApiEndpoint.get("initMarkdown", "/init.md", {
		success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
	}).annotate(
		OpenApi.Description,
		"Public editable orientation as Markdown, including live routes and an init-text-only version stamp.",
	),
	HttpApiEndpoint.get("quickstart", "/quickstart", {
		success: [
			Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
			Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
		],
	}).annotate(
		OpenApi.Description,
		"Editable post-enrollment orientation linking the board's guides, served as Markdown or HTML according to Accept. Requires read.",
	),
	HttpApiEndpoint.get("quickstartMarkdown", "/quickstart.md", {
		success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
	}).annotate(
		OpenApi.Description,
		"Editable post-enrollment orientation as Markdown, linking the board's guides. Requires read.",
	),
);

export const orientation = (markdownOnly: boolean, spec: OpenAPISpec) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const pages = yield* Pages;
		const source = yield* pages.read("init.md");
		// The prose above the table tells agents to call /api/lock, /api/fs and /api/reload, which boot
		// serves. Describe the same assembled surface /api does, and fall back to the app's own routes
		// rather than refusing orientation when boot cannot be reached.
		const endpoints = yield* liveDiscovery(spec).pipe(
			Effect.map((merged) => merged.paths),
			Effect.catchCause(() => Effect.succeed(spec.paths)),
		);
		const routeTable = Object.entries(endpoints)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, operations]) => {
				const methods = Object.keys(operations)
					.filter((method) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method))
					.sort()
					.join(" / ")
					.toUpperCase();
				return `- <code>${escapeHtml(methods)} ${escapeHtml(path)}</code>`;
			})
			.join("\n");
		const stable = `${source}\n\n## Live routes\n\n${routeTable}\n`;
		const crypto = yield* Crypto.Crypto;
		const version = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(source))).toString("hex");
		let text = `${stable}\n\nVersion ${version}.\n`;
		if (request.headers[scopesHeader]?.split(",").includes("read")) {
			const who = yield* identity("read");
			text += `\nYou are <code>${escapeHtml(`${who.agent}@${who.label ?? ""}`)}</code>. Scopes: ${escapeHtml(request.headers[scopesHeader] ?? "")}.\n`;
		}
		const html = !markdownOnly && (request.headers.accept ?? "").includes("text/html");
		return HttpServerResponse.text(html ? pages.render(text, "init.md", { rawHref: "/init.md" }) : text, {
			contentType: html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
			headers: {
				"cache-control": "no-store",
				vary: "Accept, Authorization, Cookie",
				[initVersionHeader]: version,
				...(request.headers[initHeader] && request.headers[initHeader] !== version ? { [initStaleHeader]: "1" } : {}),
			},
		});
	}).pipe(
		Effect.catchCause(() =>
			Effect.succeed(
				HttpServerResponse.text("Onboarding is unavailable. GET /_boot lists recovery tools.\n", {
					status: 503,
					headers: { "cache-control": "no-store" },
				}),
			),
		),
	);

/** The guides this page links are board pages behind a token, so the page that links them is too. */
export const quickstart = (markdownOnly: boolean) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const who = yield* identity("read");
		const pages = yield* Pages;
		const source = yield* pages.read("quickstart.md");
		const text = `${source}\nYou are <code>${escapeHtml(`${who.agent}@${who.label}`)}</code>. Scopes: ${escapeHtml(request.headers[scopesHeader] ?? "")}.\n`;
		const html = !markdownOnly && (request.headers.accept ?? "").includes("text/html");
		return HttpServerResponse.text(html ? pages.render(text, "quickstart.md", { rawHref: "/quickstart.md" }) : text, {
			contentType: html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
			headers: { "cache-control": "no-store", vary: "Accept, Authorization, Cookie" },
		});
	}).pipe(
		Effect.catchTag("PageRejected", (rejected) =>
			Effect.succeed(
				HttpServerResponse.text(
					`The quickstart page is unavailable (${rejected.code}). GET /init describes enrollment and the live routes.\n`,
					{ status: 503, headers: { "cache-control": "no-store" } },
				),
			),
		),
		failure,
	);

export const routes = (spec: OpenAPISpec) =>
	Layer.mergeAll(
		HttpRouter.add("GET", "/init", orientation(false, spec)),
		HttpRouter.add("GET", "/init.md", orientation(true, spec)),
		HttpRouter.add("GET", "/quickstart", quickstart(false)),
		HttpRouter.add("GET", "/quickstart.md", quickstart(true)),
	);
