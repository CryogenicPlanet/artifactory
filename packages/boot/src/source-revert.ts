import { Cause, Clock, Crypto, Effect, Ref, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpServerResponse } from "effect/unstable/http";
import { SourceRejected } from "./source-schema.ts";

const Outcome = Schema.Struct({ status: Schema.Int, body: Schema.Json });
const Receipt = Schema.Struct({
	selector: Schema.String,
	page_batch: Schema.NullOr(Schema.String),
	outcome: Schema.NullOr(Outcome),
	created_at: Schema.optionalKey(Schema.Int),
	completed_at: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
const Stored = Schema.fromJsonString(Receipt);
const Rows = Schema.Array(Schema.Struct({ value: Schema.String }));
const read = (id: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql`SELECT value FROM settings WHERE key=${id}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
		);
		return rows[0] ? yield* Schema.decodeEffect(Stored)(rows[0].value) : null;
	});
const save = (id: string, value: typeof Receipt.Type) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE settings SET value=${yield* Schema.encodeEffect(Stored)(value)} WHERE key=${id}`;
	});
const outcome = (id: string, value: typeof Outcome.Type) =>
	Effect.gen(function* () {
		const receipt = yield* read(id);
		if (!receipt) return yield* Effect.die("Missing source revert receipt");
		if (receipt.outcome === null)
			yield* save(id, { ...receipt, outcome: value, completed_at: yield* Clock.currentTimeMillis });
	});

/** Called inside cutover's acceptance transaction: a later crash must never execute this undo again. */
export const acceptSourceRevert = (id: string | undefined, generation: number) =>
	id === undefined ? Effect.void : outcome(id, { status: 200, body: { generation, status: "live" } });

const response = (value: typeof Outcome.Type) =>
	HttpServerResponse.jsonUnsafe(value.body, {
		status: value.status,
		headers: { "cache-control": "no-store" },
	});
const refusal = (code: string, status: number, hint: string): typeof Outcome.Type => ({
	status,
	body: { error: { code, message: "Source revert did not complete.", hint, retriable: status === 503 } },
});
const pending = refusal(
	"source_revert_pending",
	503,
	"Inspect /_boot/status and finish source recovery; this request will not execute again.",
);
const interrupted = refusal(
	"source_revert_interrupted",
	409,
	"The earlier request stopped before acceptance. Inspect source, staging and generations before making a new request with a new key.",
);

/** Owns only source-revert receipts and their serialization, not the publication or cutover protocol. */
export const sourceReverts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const gate = yield* Semaphore.make(1);
	const context = yield* Effect.context<SqlClient.SqlClient>();
	const reconcilePage = (id: string, receipt: typeof Receipt.Type) =>
		Effect.gen(function* () {
			if (receipt.outcome !== null) {
				if (receipt.completed_at !== undefined && receipt.completed_at !== null) return receipt;
				// Historical terminal receipts have no trustworthy age. Start their full window when observed.
				const stamped = { ...receipt, completed_at: yield* Clock.currentTimeMillis };
				yield* save(id, stamped);
				return stamped;
			}
			if (receipt.page_batch === null) return receipt;
			const batches = yield* sql`SELECT state FROM source_batches WHERE id=${receipt.page_batch}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: Schema.String })))),
			);
			if (!batches[0]) return yield* Effect.die("Missing source revert publication journal");
			if (batches[0].state !== "published") return receipt;
			const completed = {
				...receipt,
				completed_at: yield* Clock.currentTimeMillis,
				outcome: { status: 200, body: { published: true, batch: receipt.page_batch } },
			};
			yield* save(id, completed);
			return completed;
		});
	const cursor = yield* Ref.make("source-revert-result:");
	const prune = gate
		.withPermit(
			sql.withTransaction(
				Effect.gen(function* () {
					// A current durable publication/cutover owner may still need an otherwise terminal receipt.
					if (
						(yield* sql`SELECT singleton FROM cutover LIMIT 1`).length > 0 ||
						(yield* sql`SELECT id FROM source_batches WHERE state='publishing' LIMIT 1`).length > 0
					)
						return 0;
					const after = yield* Ref.get(cursor);
					const rows =
						yield* sql`SELECT key,value FROM settings WHERE key>${after} AND key<'source-revert-result:~' ORDER BY key LIMIT 256`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
							),
						);
					const now = yield* Clock.currentTimeMillis;
					let deleted = 0;
					for (const row of rows) {
						const stored = yield* Schema.decodeEffect(Stored)(row.value);
						// Never infer a terminal outcome from age or discard unresolved journal bindings.
						if (stored.outcome === null) continue;
						if (
							stored.page_batch !== null &&
							!(yield* sql`SELECT id FROM source_batches WHERE id=${stored.page_batch} AND state='published'`).length
						)
							continue;
						const receipt = yield* reconcilePage(row.key, stored);
						if (
							receipt.completed_at !== undefined &&
							receipt.completed_at !== null &&
							receipt.completed_at < now - 30 * 86_400_000
						) {
							yield* sql`DELETE FROM settings WHERE key=${row.key}`;
							deleted++;
						}
					}
					yield* Ref.set(
						cursor,
						rows.length === 256 ? (rows.at(-1)?.key ?? "source-revert-result:") : "source-revert-result:",
					);
					return deleted;
				}),
			),
		)
		.pipe(Effect.provideContext(context));
	return {
		prune,
		retain: Effect.sleep("1 hour").pipe(
			Effect.andThen(
				prune.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logError("Source revert retention failed", cause),
					),
				),
			),
			Effect.forever,
		),
		// SQL only: SourceFiles already holds its gate and the journal admission transaction.
		bindPage: (id: string, batch: string) =>
			Effect.gen(function* () {
				const receipt = yield* read(id);
				if (!receipt || receipt.outcome !== null || receipt.page_batch !== null)
					return yield* Effect.die("Invalid source revert publication binding");
				yield* save(id, { ...receipt, page_batch: batch });
			}).pipe(Effect.provideContext(context)),
		// Only call after keeper closure and cutover recovery. Failed page recovery stays pending.
		recover: sql
			.withTransaction(
				Effect.gen(function* () {
					const rows = yield* sql`SELECT key,value FROM settings WHERE key LIKE 'source-revert-result:%'`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
						),
					);
					for (const row of rows) {
						const receipt = yield* reconcilePage(row.key, yield* Schema.decodeEffect(Stored)(row.value));
						if (receipt.outcome === null && receipt.page_batch === null) yield* outcome(row.key, interrupted);
					}
				}),
			)
			.pipe(Effect.provideContext(context)),
		run: <E, R, R2>(
			identity: { readonly family: string; readonly key: string },
			selector: string,
			authorize: Effect.Effect<void, E, R>,
			operation: (id: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R2>,
		) =>
			gate
				.withPermit(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							// Credentials may expire or be revoked while another source revert owns the gate.
							yield* authorize;
							const encoded = yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Struct({ family: Schema.String, key: Schema.String })),
							)(identity);
							const digest = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded))).toString(
								"hex",
							);
							const id = `source-revert-result:${digest}`;
							const existing = yield* read(id);
							if (existing) {
								if (existing.selector !== selector)
									return yield* new SourceRejected({ code: "idempotency_conflict", path: "revert" });
								const receipt = yield* sql.withTransaction(reconcilePage(id, existing));
								return response(receipt.outcome ?? pending);
							}
							// Old releases bound selection only, and may already have performed the undo.
							// Refuse an unknown historical outcome rather than executing that key a second time.
							const legacy = yield* sql`SELECT key FROM settings WHERE key=${`source-revert:${digest}`}`;
							if (legacy.length > 0)
								return response(
									refusal(
										"source_revert_outcome_unavailable",
										409,
										"This key predates exact outcome receipts. Inspect source and history, then use a new key only for a new operation.",
									),
								);
							yield* sql`INSERT INTO settings(key,value) VALUES(${id},${yield* Schema.encodeEffect(Stored)({ selector, page_batch: null, outcome: null, created_at: yield* Clock.currentTimeMillis, completed_at: null })})`;
							const result = yield* restore(operation(id)).pipe(Effect.exit);
							// Publication/acceptance evidence wins over a lost completion or cleanup error.
							const durable = yield* sql.withTransaction(
								Effect.gen(function* () {
									const stored = yield* read(id);
									if (!stored) return yield* Effect.die("Missing source revert receipt");
									const receipt = yield* reconcilePage(id, stored);
									if (receipt.outcome !== null) return receipt.outcome;
									if (receipt.page_batch !== null || (yield* sql`SELECT singleton FROM cutover`).length > 0)
										return pending;
									if (result._tag === "Failure") {
										yield* outcome(id, interrupted);
										return interrupted;
									}
									if (result.value.body._tag !== "Uint8Array")
										return yield* Effect.die("Source revert response must be JSON bytes");
									const body = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
										new TextDecoder().decode(result.value.body.body),
									);
									const value = { status: result.value.status, body };
									yield* outcome(id, value);
									return value;
								}),
							);
							if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
							return response(durable);
						}),
					),
				)
				.pipe(Effect.provideContext(context)),
	};
});
export type SourceReverts = Effect.Success<typeof sourceReverts>;
