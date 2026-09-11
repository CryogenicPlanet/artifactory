import { Effect, Schema } from "effect";
import type { Api } from "../../src/kernel/extension-api.ts";

// To install as app/ext/digest.ts, change the type import to ../kernel/extension-api.ts.
// Both reads use core services; the digest is not a shared cross-request snapshot.
export default function digest(api: Api) {
	api.route("GET", "/api/digest", {
		description: "Render a topic and your agent home/mentions as Markdown; optional topic and limit (1–200).",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const topic = ctx.query.topic ?? "";
				const requestedLimit = ctx.query.limit ?? "50";
				if (typeof topic !== "string" || typeof requestedLimit !== "string")
					return Response.json(
						{
							error: {
								code: "query_invalid",
								message: "Use one topic and limit.",
								hint: "Remove duplicate query values.",
								retriable: false,
							},
						},
						{ status: 400 },
					);
				const limit = Number(requestedLimit);
				if (!/^\d+$/.test(requestedLimit) || !Number.isInteger(limit) || limit < 1 || limit > 200)
					return Response.json(
						{
							error: {
								code: "query_invalid",
								message: "Invalid limit.",
								hint: "Use an integer from 1 to 200.",
								retriable: false,
							},
						},
						{ status: 400 },
					);
				const detail = yield* ctx.topics.read(topic);
				const addressed = yield* ctx.messages.query({
					topic: `@${ctx.agent}`,
					recursive: true,
					mentions: [`@${ctx.agent}`, "@here"],
					exclude: ctx.instance,
					since: 0,
					newest: true,
					limit,
				});
				const encodeMeta = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject));
				const meta = yield* encodeMeta(detail.meta);
				const subtopics = yield* Effect.forEach(detail.subtopics, (child) =>
					encodeMeta(child.meta).pipe(Effect.map((value) => `- ${child.path}: ${value}`)),
				);
				const lines = [
					`# ${topic || "Board"}`,
					detail.index ?? "",
					`Metadata: ${meta}`,
					"## Subtopics",
					...subtopics,
					"## Recent topic messages",
					...detail.messages
						.slice(-limit)
						.map((message) => `### #${message.seq} · ${message.agent}\n\n${message.body}`),
					"## Agent home and mentions",
					...addressed.items.map(
						(message) => `### #${message.seq} · ${message.topic} · ${message.agent}\n\n${message.body}`,
					),
					"## Pages",
					...detail.pages.map((name) => {
						const path = [...(topic ? topic.split("/") : []), name].map(encodeURIComponent).join("/");
						return `- [${name}](/p/${path})`;
					}),
				];
				return new Response(lines.join("\n\n"), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
			}),
	});
}
