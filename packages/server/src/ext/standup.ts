import { DateTime, Effect, Schema } from "effect";
import { publishedMessages } from "../kernel/published-messages.ts";
import type { Api } from "../kernel/extension-api.ts";

/** A deliberately small example; SQL reads use the same app connection as the kernel. */
export default function standup(api: Api) {
	api.route("GET", "/api/standup", {
		description: "Count published messages by agent within the most recent day.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const since = (yield* DateTime.nowAsDate).getTime() - 86400000;
				const rows = yield* ctx.db.withTransaction(
					Effect.gen(function* () {
						yield* ctx.db`SELECT epoch FROM kernel_writer`;
						const ceiling = (yield* ctx.publicationFence).published_through;
						return yield* ctx.db`WITH visible_messages AS (${publishedMessages(ctx.db, ceiling)})
  SELECT agent,COUNT(*) AS messages FROM visible_messages
  WHERE deleted_at IS NULL AND created_at>=${since} GROUP BY agent ORDER BY agent`;
					}),
				);
				return Response.json(
					yield* Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ agent: Schema.String, messages: Schema.Int })),
					)(rows),
				);
			}),
	});
}
