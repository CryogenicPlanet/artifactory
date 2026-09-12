import { Crypto, DateTime, Effect, Schema } from "effect";
import type { RequestContext, BackgroundContext } from "../../kernel/extension-api.ts";
import { created, Input, Stored, SubscriptionError } from "./contract.ts";
import { greatest } from "@comms/storage/dialect";

type Context = Pick<BackgroundContext, "db" | "read" | "emit" | "mutate">;
export const makeStore = (ctx: Context) => {
	const sql = ctx.db;
	const rows = Schema.decodeUnknownEffect(Schema.Array(Stored));
	const visible = ctx.read((fence) =>
		sql`SELECT * FROM webhook_subscriptions WHERE created_seq<=${fence} AND (deleted_seq IS NULL OR deleted_seq>${fence}) ORDER BY created_at,id`.pipe(
			Effect.flatMap(rows),
		),
	);
	return {
		visible,
		create: (who: RequestContext, input: Input, key: string | null) =>
			Effect.gen(function* () {
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Input))(input);
				if (key !== null) {
					const prior = yield* ctx.read((fence) =>
						sql`SELECT * FROM webhook_subscriptions WHERE instance=${who.instance} AND idempotency_key=${key}`.pipe(
							Effect.flatMap(rows),
							Effect.flatMap((items) =>
								items[0] && items[0].created_seq > fence
									? Effect.fail(new SubscriptionError({ code: "subscription_unavailable" }))
									: Effect.succeed(items[0]),
							),
						),
					);
					if (prior) {
						if ((yield* Schema.encodeEffect(Schema.fromJsonString(Input))(prior.input)) !== encoded)
							return yield* new SubscriptionError({ code: "idempotency_conflict" });
						return created(prior);
					}
				}
				if ((yield* visible).length >= 32) return yield* new SubscriptionError({ code: "subscription_limit" });
				const crypto = yield* Crypto.Crypto;
				const id = "sub_" + Buffer.from(yield* crypto.randomBytes(12)).toString("hex"),
					at = (yield* DateTime.nowAsDate).getTime(),
					since = yield* ctx.read((fence) => Effect.succeed(fence));
				yield* ctx.emit("subscription.created", {}, (seq) =>
					sql`INSERT INTO webhook_subscriptions(id,instance,agent,human,input,idempotency_key,created_at,start_seq,created_seq,${sql("cursor")}) VALUES(${id},${who.instance},${who.agent},${who.kind === "human" ? 1 : 0},${encoded},${key},${at},${since},${seq},${since})`.pipe(
						Effect.asVoid,
					),
				);
				return { id, filter: input.filter, deliver: input.deliver, created_at: at, since };
			}),
		remove: (who: RequestContext, id: string) =>
			Effect.gen(function* () {
				const found = yield* ctx.read(() =>
					sql`SELECT * FROM webhook_subscriptions WHERE id=${id}`.pipe(
						Effect.flatMap(rows),
						Effect.map((items) => items[0]),
					),
				);
				if (!found || (who.kind !== "human" && found.instance !== who.instance))
					return yield* new SubscriptionError({ code: "subscription_not_found" });
				if (found.deleted_seq === null)
					yield* ctx.emit("subscription.deleted", {}, (seq) =>
						sql`UPDATE webhook_subscriptions SET deleted_seq=${seq} WHERE id=${id} AND deleted_seq IS NULL`.pipe(
							Effect.asVoid,
						),
					);
				else if (found.deleted_seq > (yield* ctx.read((fence) => Effect.succeed(fence))))
					return yield* new SubscriptionError({ code: "subscription_unavailable" });
			}),
		checkpoint: (row: Stored, cursor: number, error: string | null) =>
			ctx.mutate(
				Effect.gen(function* () {
					const attempts = error === null ? 0 : Math.min(row.attempts + 1, 30);
					const next =
						error === null
							? 0
							: (yield* DateTime.nowAsDate).getTime() + Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6));
					yield* sql`UPDATE webhook_subscriptions SET ${sql("cursor")}=${greatest(sql, sql("cursor"), cursor)},attempts=${attempts},next_attempt=${next},last_error=${error} WHERE id=${row.id} AND deleted_seq IS NULL AND ${sql("cursor")}=${row.cursor}`;
				}),
			),
	};
};
