import { Cause, Effect, Schema } from "effect";
import type { Api, BackgroundContext } from "../kernel/extension-api.ts";
import { on } from "@comms/storage/dialect";

/** The event log remains authoritative; this removable extension provides a reading view. */
export default function system(api: Api) {
	return Effect.gen(function* () {
		yield* api.migrate("system_cursor", {
			sqlite: "CREATE TABLE IF NOT EXISTS system_cursor (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL)",
			pg: "CREATE TABLE IF NOT EXISTS system_cursor (id INTEGER PRIMARY KEY, seq BIGINT NOT NULL)",
			mysql: "CREATE TABLE IF NOT EXISTS system_cursor (id INTEGER PRIMARY KEY, seq BIGINT NOT NULL) ENGINE=InnoDB",
		});
		api.on("start", ({ reason }: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
			reason === "live" ? mirror(ctx).pipe(Effect.forkScoped, Effect.asVoid) : Effect.void,
		);
	});
}

const mirror = (ctx: BackgroundContext) =>
	Effect.gen(function* () {
		while (true) {
			const cycle = yield* Effect.gen(function* () {
				const rows = yield* ctx
					.read(() => ctx.db`SELECT seq FROM system_cursor WHERE id=1`)
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))));
				const since = rows[0]?.seq ?? 0;
				const page = yield* ctx.events.query({ since, limit: 64 });
				for (const event of page.items) {
					// Request diagnostics are caller-private, even when their level is warn/error.
					if (
						event.type === "http.request" ||
						!(
							event.level === "warn" ||
							event.level === "error" ||
							/^(enrollment|lock|generation)\./.test(event.type) ||
							event.type === "token.family_revoked"
						)
					)
						continue;
					yield* ctx.messages.create(
						{
							topic: "system",
							body: `${event.level}: ${event.type.slice(0, 128)} — ${event.actor.slice(0, 64)} (event ${event.seq})`,
							tags: ["system"],
							meta: { event_seq: event.seq, event_at: event.at, event_type: event.type.slice(0, 128) },
						},
						`system-event:${event.seq}`,
					);
				}
				if (page.cursor > since)
					yield* ctx.mutate(
						ctx.db`INSERT INTO system_cursor(id,seq) VALUES(1,${page.cursor}) ${on(ctx.db, {
							sqlite: () => ctx.db`ON CONFLICT(id) DO UPDATE SET seq=excluded.seq`,
							pg: () => ctx.db`ON CONFLICT(id) DO UPDATE SET seq=excluded.seq`,
							mysql: () => ctx.db`AS incoming ON DUPLICATE KEY UPDATE seq=incoming.seq`,
						})}`.pipe(Effect.asVoid),
					);
				if (page.items.length < 64) yield* ctx.events.changed(page.cursor);
			}).pipe(Effect.exit);
			if (cycle._tag === "Failure") {
				if (Cause.hasInterruptsOnly(cycle.cause)) return yield* Effect.interrupt;
				yield* Effect.sleep("500 millis");
			}
		}
	});
