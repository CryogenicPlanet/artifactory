import { Crypto, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { Lifecycle } from "./lifecycle.ts";
import { Messages, type Identity } from "./messages.ts";

/** Per-extension scratch data and logs use the kernel's serialized, epoch-fenced outbox. */
export const extensionData = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const messages = yield* Messages;
	const lifecycle = yield* Lifecycle;
	return (filename: string, who?: Identity, writable = true) => {
		const namespace = filename;
		const record = <E = never>(
			type: string,
			payload: Schema.JsonObject,
			change?: (seq: number) => Effect.Effect<void, E>,
		) =>
			Effect.gen(function* () {
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
					return yield* new KernelError({ code: "input_invalid" });
				const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
				return yield* messages.recordEvent(
					{
						transaction,
						type,
						level: "info",
						payload: Object.fromEntries([...Object.entries(payload), ["extension", namespace]]),
						...(who ? { actor: who.agent, instance: who.instance, request: who.request } : {}),
					},
					change,
				);
			}).pipe(Effect.provideService(Lifecycle, lifecycle), Effect.provideService(Crypto.Crypto, crypto));
		return {
			log: (type: string, payload: Schema.JsonObject) => record(type, payload).pipe(Effect.asVoid),
			kv: (ns = namespace) => {
				const valid = (key: string) =>
					ns === namespace &&
					typeof key === "string" &&
					key.length > 0 &&
					key.length <= 200 &&
					!key.split("").some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
				const write = (key: string, value: Schema.Json | undefined) =>
					Effect.gen(function* () {
						if (!writable) return yield* new KernelError({ code: "scope_required" });
						if (!valid(key)) return yield* new KernelError({ code: "input_invalid" });
						const encoded =
							value === undefined ? null : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(value);
						if (encoded !== null && new TextEncoder().encode(encoded).byteLength > 65536)
							return yield* new KernelError({ code: "input_invalid" });
						yield* record(value === undefined ? "kv.deleted" : "kv.set", { key }, (seq) =>
							sql`INSERT INTO kv(ns,key,value,updated_seq,previous) VALUES(${namespace},${key},${encoded},${seq},NULL) ON CONFLICT(ns,key) DO UPDATE SET previous=kv.value,value=excluded.value,updated_seq=excluded.updated_seq`.pipe(
								Effect.asVoid,
							),
						);
					});
				return {
					get: (key: string) =>
						sql.withTransaction(
							Effect.gen(function* () {
								if (!valid(key)) return yield* new KernelError({ code: "input_invalid" });
								yield* sql`SELECT epoch FROM kernel_writer`;
								const fence = (yield* messages.fence).published_through;
								const rows =
									yield* sql`SELECT CASE WHEN updated_seq<=${fence} THEN value ELSE previous END AS value FROM kv WHERE ns=${namespace} AND key=${key}`.pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Array(Schema.Struct({ value: Schema.NullOr(Schema.fromJsonString(Schema.Json)) })),
											),
										),
									);
								return rows[0]?.value ?? null;
							}),
						),
					set: (key: string, value: Schema.Json) => write(key, value),
					delete: (key: string) => write(key, undefined),
				};
			},
		};
	};
});
export type ExtensionData = ReturnType<Effect.Success<typeof extensionData>>;
