import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { remoteRecovery } from "../../src/app-recovery.ts";
import { remoteAppStoreIdentity } from "../../src/app-store-identity.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { remoteRestoreSelection } from "../../src/remote-restore-selection.ts";
import { withDatabase } from "@comms/storage/store";

const main = Effect.gen(function* () {
	yield* initializeBootSchema;
	const sql = yield* SqlClient.SqlClient;
	const app = {
		_tag: "postgres",
		url: Redacted.make("postgres://app:never-print@example.test/original"),
		database: "original",
	} as const;
	const boot = { ...app, url: Redacted.make("postgres://boot:never-print@example.test/boot"), database: "boot" };
	const identity = yield* remoteAppStoreIdentity(app);
	yield* identity.complete(yield* identity.reserve);
	const recovery = yield* remoteRecovery({
		appStore: app,
		bootStore: boot,
		dataDirectory: "/unused",
		authorizeStoreAccess: () => Effect.die("Must not authorize original store"),
		withStore: () => Effect.die("Must not open original store"),
		initialize: () => Effect.die("Must not initialize original store"),
	});
	const before = yield* remoteRestoreSelection(recovery);
	const refused = <A, E>(effect: Effect.Effect<A, E>) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => result._tag === "Failure"),
		);
	if (!(yield* refused(before.record("proof")))) return yield* Effect.die("Out-of-transaction record accepted");
	const rolledBack = yield* sql
		.withTransaction(before.record("proof").pipe(Effect.andThen(Effect.fail("rollback"))))
		.pipe(Effect.result);
	if (rolledBack._tag !== "Failure" || (yield* before.read("proof")) !== null)
		return yield* Effect.die("Uncommitted selection persisted");
	yield* sql.withTransaction(before.record("proof"));
	yield* sql.withTransaction(before.record("proof"));
	const saved = yield* sql`SELECT value FROM settings WHERE key='restore-remote-before:proof'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
	);
	const text = saved[0]?.value;
	if (!text || text.includes("never-print") || text.includes("postgres://"))
		return yield* Effect.die("Selection exposed credentials");
	const target = yield* withDatabase(app, "restored");
	yield* sql.withTransaction(identity.selectRestored(target));
	if ((yield* before.read("proof"))?.database !== "original")
		return yield* Effect.die("Original changed after target selection");
	if (!(yield* refused(sql.withTransaction(before.record("proof"))))) return yield* Effect.die("Selection rebound");
	const original = yield* before.read("proof");
	if (!original) return yield* Effect.die("Original missing");
	yield* sql.withTransaction(identity.selectRestored(original));
	if ((yield* identity.store).database !== "original") return yield* Effect.die("Rollback pointer failed");
	const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(text);
	for (const patch of [
		{ endpoint: "other.test:5432" },
		{ engine: "mysql" },
		{ store_id: "foreign" },
		{ database: "../other" },
		{ unexpected: true },
	]) {
		const changed = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ ...decoded, ...patch });
		yield* sql`UPDATE settings SET value=${changed} WHERE key='restore-remote-before:proof'`;
		if (!(yield* refused(before.read("proof")))) return yield* Effect.die("Corrupt selection accepted");
	}
	yield* Console.log("selection-proved");
}).pipe(
	Effect.provide(eventsLayer(Effect.void)),
	Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
	Effect.provide(BunServices.layer),
);
main.pipe(BunRuntime.runMain);
