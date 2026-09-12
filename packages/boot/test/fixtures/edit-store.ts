import { layer as durableEventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditAuthority, EditLock, layer as rawEditLockLayer } from "../../src/edit-lock.ts";

const layer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const Input = Schema.Struct({
	repair: Schema.optional(Schema.Boolean),
	op: Schema.Literals([
		"init",
		"acquire",
		"inspect",
		"stage",
		"overlay",
		"release",
		"pin",
		"finish",
		"break",
		"revoke",
		"recover",
		"interrupt",
	]),
	family: Schema.optional(Schema.String),
	id: Schema.optional(Schema.String),
	ttl: Schema.optional(Schema.Finite),
	note: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	content: Schema.optional(Schema.NullOr(Schema.String)),
	succeeded: Schema.optional(Schema.Boolean),
	release: Schema.optional(Schema.Boolean),
	resetPin: Schema.optional(Schema.Literals([0, 1, 2])),
});
const main = Effect.gen(function* () {
	const filename = process.argv[2];
	if (!filename) return yield* Effect.die("Missing database");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const operation = Effect.gen(function* () {
		const service = yield* EditLock;
		const owner = { id: input.id ?? "", family: input.family ?? "one" };
		switch (input.op) {
			case "init":
				return yield* initializeBootSchema;
			case "inspect":
				return yield* service.inspect;
			case "acquire":
				return yield* service.acquire(owner.family, "codex", {
					...(input.ttl === undefined ? {} : { ttl: input.ttl }),
					...(input.note === undefined ? {} : { note: input.note }),
				});
			case "stage":
				return yield* service.stage(
					owner,
					input.path ?? "app/main.ts",
					input.content === null ? null : new TextEncoder().encode(input.content ?? "source"),
				);
			case "overlay":
				return yield* service.overlay(owner);
			case "release":
				return yield* service.release(owner);
			case "pin":
				return yield* service.pin(owner, input.resetPin);
			case "finish":
				return yield* service.finish(owner, { succeeded: input.succeeded ?? false, release: input.release ?? false });
			case "break":
				return yield* service.breakLock(owner.id);
			case "revoke":
				return yield* service.revokeFamily(owner.family);
			case "recover":
				return yield* service.recover;
			case "interrupt": {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* service.stage(owner, "app/interrupted.ts", new TextEncoder().encode("partial"));
						yield* Console.log("UNCOMMITTED");
						return yield* Effect.never;
					}),
				);
			}
		}
	}).pipe(
		Effect.catchTag("EditRejected", (error) =>
			Effect.succeed({ error: error.code, holder: error.holder, transitions: error.transitions }),
		),
	);
	const guarded = input.repair
		? operation.pipe(
				Effect.provideService(EditAuthority, {
					kind: "human",
					id: "repair",
					expiresAt: Number.MAX_SAFE_INTEGER,
					repairLock: true,
				}),
			)
		: operation;
	const result = yield* guarded.pipe(
		Effect.provide(layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename, disableWAL: true })))),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result ?? null));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
