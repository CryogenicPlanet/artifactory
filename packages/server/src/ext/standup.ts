import { DateTime, Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";

/** Page through public message projections inside one publication snapshot. */
export default function standup(api: Api) {
	api.route("GET", "/api/standup", {
		description: "Count published messages by agent within the most recent day.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const since = (yield* DateTime.nowAsDate).getTime() - 86400000;
				const rows = yield* ctx.read((fence) =>
					Effect.gen(function* () {
						const counts = new Map<string, number>();
						let cursor = 0;
						while (cursor < fence) {
							const page = yield* ctx.messages.query({ since: cursor, limit: 200 });
							for (const message of page.items)
								if (message.created_at >= since) counts.set(message.agent, (counts.get(message.agent) ?? 0) + 1);
							cursor = page.cursor;
						}
						return Array.from(counts, ([agent, messages]) => ({ agent, messages })).sort((a, b) =>
							a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0,
						);
					}),
				);
				return Response.json(rows);
			}),
	});
}
