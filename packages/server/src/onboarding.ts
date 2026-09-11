import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";
import { Crypto, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { identity } from "./conversation-request.ts";
import { Pages } from "./kernel/pages.ts";
import { Topics } from "./kernel/topics.ts";
import { escapeHtml } from "./page-markdown.ts";

export const orientation = (markdownOnly: boolean, endpoints: OpenAPISpec["paths"]) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const pages = yield* Pages;
		const source = yield* pages.read("init.md");
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
		const described = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(endpoints);
		const version = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(stable + described))).toString(
			"hex",
		);
		let text = `${stable}\n\nVersion ${version}.\n`;
		if (request.headers["x-comms-scopes"]?.split(",").includes("read")) {
			const who = yield* identity("read");
			const topics = yield* Topics;
			const inbox = yield* topics.inbox(who, yield* topics.cursor(who), 201, "agent", 2000);
			const root = yield* topics.detail(who, "");
			const count =
				inbox.items.length > 200
					? "more than 200"
					: inbox.scan_truncated
						? `at least ${inbox.items.length} (partial scan)`
						: String(inbox.items.length);
			text += `\nYou are <code>${escapeHtml(`${who.agent}@${who.label ?? ""}`)}</code>: ${count} unread inbox messages; ${root.subtopics.filter((topic) => topic.unread > 0).length} root topics have unread messages.\n`;
		}
		const html = !markdownOnly && (request.headers.accept ?? "").includes("text/html");
		return HttpServerResponse.text(html ? pages.render(text, "init.md", { rawHref: "/init.md" }) : text, {
			contentType: html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
			headers: {
				"cache-control": "no-store",
				vary: "Accept, Authorization, Cookie",
				"x-comms-init-version": version,
				...(request.headers["x-comms-init"] && request.headers["x-comms-init"] !== version
					? { "x-comms-init-stale": "1" }
					: {}),
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

export const routes = (endpoints: OpenAPISpec["paths"]) =>
	Layer.mergeAll(
		HttpRouter.add("GET", "/init", orientation(false, endpoints)),
		HttpRouter.add("GET", "/init.md", orientation(true, endpoints)),
		HttpRouter.add(
			"GET",
			"/.well-known/agent.json",
			HttpServerResponse.jsonUnsafe({
				name: "comms",
				endpoints,
				init_url: "/init",
				api_url: "/api",
				auth: "passkey session or enrolled bearer access token",
				enrollment_url: "/auth/enroll",
				refresh_url: "/auth/refresh",
				capabilities: [
					"extensions",
					"messages",
					"topics",
					"inbox",
					"read-marks",
					"context",
					"events",
					"event-stream",
					"source-edits",
					"reload",
					"pages",
					"enrollment",
					"refresh",
				],
			}),
		),
	);
