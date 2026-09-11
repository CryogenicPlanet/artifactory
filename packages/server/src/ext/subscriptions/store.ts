import { Crypto, DateTime, Effect, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { Lifecycle } from "../../kernel/lifecycle.ts";
import { Messages, type Identity } from "../../kernel/messages.ts";
import { writerGate } from "../../kernel/database.ts";
import { created, Input, Stored, SubscriptionError } from "./contract.ts";

export const makeStore = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient,
		boot = yield* BootChannel,
		messages = yield* Messages,
		crypto = yield* Crypto.Crypto,
		lifecycle = yield* Lifecycle;
	const rows = Schema.decodeUnknownEffect(Schema.Array(Stored));
	const live = Ref.get(lifecycle.state).pipe(
		Effect.flatMap((state) =>
			state === "live" ? Effect.void : Effect.fail(new KernelError({ code: "generation_not_live" })),
		),
	);
	const visible = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT epoch FROM kernel_writer`;
			const fence = (yield* messages.fence).published_through;
			return yield* sql`SELECT * FROM webhook_subscriptions WHERE created_seq<=${fence} AND (deleted_seq IS NULL OR deleted_seq>${fence}) ORDER BY created_at,id`.pipe(
				Effect.flatMap(rows),
			);
		}),
	);
	const change = <E>(type: string, who: Identity | undefined, run: (seq: number) => Effect.Effect<void, E>) =>
		Effect.gen(function* () {
			yield* live;
			const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
			yield* messages.recordEvent(
				{
					transaction,
					type,
					level: "info",
					payload: { extension: "subscriptions" },
					...(who ? { actor: who.agent, instance: who.instance, request: who.request } : {}),
				},
				run,
			);
		}).pipe(Effect.provideService(Lifecycle, lifecycle), Effect.provideService(Crypto.Crypto, crypto));
	return {
		live,
		visible,
		admit: sql.withTransaction(writerGate(sql, boot.epoch)),
		create: (who: Identity, input: Input, key: string | null) =>
			Effect.gen(function* () {
				yield* live;
				yield* messages.relay;
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Input))(input);
				if (key !== null) {
					const prior =
						yield* sql`SELECT * FROM webhook_subscriptions WHERE instance=${who.instance} AND idempotency_key=${key}`.pipe(
							Effect.flatMap(rows),
						);
					if (prior[0]) {
						if ((yield* Schema.encodeEffect(Schema.fromJsonString(Input))(prior[0].input)) !== encoded)
							return yield* new SubscriptionError({ code: "idempotency_conflict", status: 409 });
						return created(prior[0]);
					}
				}
				if ((yield* visible).length >= 32)
					return yield* new SubscriptionError({ code: "subscription_limit", status: 409 });
				const id = "sub_" + Buffer.from(yield* crypto.randomBytes(12)).toString("hex"),
					at = (yield* DateTime.nowAsDate).getTime(),
					since = (yield* messages.fence).published_through;
				yield* change("subscription.created", who, (seq) =>
					sql`INSERT INTO webhook_subscriptions(id,instance,agent,human,input,idempotency_key,created_at,start_seq,created_seq,cursor) VALUES(${id},${who.instance},${who.agent},${who.kind === "human" ? 1 : 0},${encoded},${key},${at},${since},${seq},${since})`.pipe(
						Effect.asVoid,
					),
				);
				return { id, filter: input.filter, deliver: input.deliver, created_at: at, since };
			}),
		remove: (who: Identity, id: string) =>
			Effect.gen(function* () {
				yield* live;
				yield* messages.relay;
				const found = (yield* sql`SELECT * FROM webhook_subscriptions WHERE id=${id}`.pipe(Effect.flatMap(rows)))[0];
				if (!found || (who.kind !== "human" && found.instance !== who.instance))
					return yield* new SubscriptionError({ code: "subscription_not_found", status: 404 });
				if (found.deleted_seq === null)
					yield* change("subscription.deleted", who, (seq) =>
						sql`UPDATE webhook_subscriptions SET deleted_seq=${seq} WHERE id=${id} AND deleted_seq IS NULL`.pipe(
							Effect.asVoid,
						),
					);
			}),
		checkpoint: (row: Stored, cursor: number, error: string | null) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					const attempts = error === null ? 0 : Math.min(row.attempts + 1, 30);
					const next =
						error === null
							? 0
							: (yield* DateTime.nowAsDate).getTime() + Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6));
					yield* sql`UPDATE webhook_subscriptions SET cursor=MAX(cursor,${cursor}),attempts=${attempts},next_attempt=${next},last_error=${error} WHERE id=${row.id} AND deleted_seq IS NULL AND cursor=${row.cursor}`;
				}),
			),
	};
});
