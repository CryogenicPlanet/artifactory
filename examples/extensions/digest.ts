import { Effect, Option, Schema } from "effect";
import type { Api } from "../../packages/server/src/kernel/extension-api.ts";

const querySchema = Schema.Struct({
	topic: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.String),
});

export default function digest(api: Api) {
	api.route("GET", "/api/digest", {
		description:
			"Markdown digest without advancing read marks. Requires read. topic defaults to root; mentions is a comma list, defaulting to @your-agent,@here. Shows 20 recent topic messages and 20 mentions; edit this extension to change ordering or window sizes.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const query = Schema.decodeOption(querySchema, { onExcessProperty: "error" })(ctx.query);
				if (Option.isNone(query))
					return Response.json(
						{
							error: {
								code: "query_invalid",
								message: "Invalid digest query.",
								hint: "Use optional topic and mentions strings, each once; no other query keys.",
								retriable: false,
							},
						},
						{ status: 400 },
					);
				const topic = query.value.topic ?? "";
				const detail = yield* ctx.topics.read(topic);
				const mentions = yield* ctx.messages.query({
					mentions: query.value.mentions?.split(",") ?? [`@${ctx.agent}`, "@here"],
					exclude: ctx.instance,
					newest: true,
					limit: 20,
				});
				const recent = detail.messages
					.slice(-20)
					.toSorted(
						(left, right) =>
							Number(right.meta.pinned === true) - Number(left.meta.pinned === true) || right.seq - left.seq,
					);
				const text =
					[
						`# ${topic || "comms"}`,
						...(detail.index === null ? [] : ["## README", detail.index]),
						`Meta: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(detail.meta)}`,
						"## Recent messages (pinned first within this window)",
						...recent.map((message) => `### #${message.seq} · ${message.agent}\n\n${message.body}`),
						"## Subtopics",
						...detail.subtopics.slice(0, 20).map((child) => `- ${child.path} · unread: ${child.unread}`),
						"## Pages",
						...detail.pages.map(
							(file) => `/p/${[topic, file].filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/")}`,
						),
						"## Mentions (latest first)",
						...mentions.items
							.toReversed()
							.map((message) => `### #${message.seq} · ${message.topic} · ${message.agent}\n\n${message.body}`),
						`Sources: topic fence ${detail.fence}; mentions cursor ${mentions.cursor}. Separate published reads, not one shared snapshot. Windows may omit older items; use the message API for complete history.`,
					].join("\n\n") + "\n";
				return new Response(text, {
					headers: {
						"content-type": "text/markdown; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			}),
	});
}
