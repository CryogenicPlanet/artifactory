import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";
import { assertNoPendingMigration } from "../../src/kernel/migration-intent.ts";
import type { Api, BackgroundContext, RequestContext } from "../../src/kernel/extension-api.ts";
import { work, type Work } from "../../src/kernel/extension-work.ts";
import subscriptions from "../../src/ext/subscriptions/index.ts";
import system from "../../src/ext/system.ts";
import { makeStore } from "../../src/ext/subscriptions/store.ts";
import { SubscriptionError, type Input } from "../../src/ext/subscriptions/contract.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_BUNDLED_EXTENSIONS_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable config");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (!settings.database.startsWith("comms_schema_")) throw new Error("Disposable schema database required");
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "b7".repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);

await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		// The fixture must receive an empty disposable database; it never drops existing data.
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,'bundled-probe')`;
		yield* initializeRemoteKernelSchema(sql, "bundled-probe");
		const sequence = yield* Ref.make(3_000_000_000);
		const unavailable = () => Effect.die("Unexpected extension capability");
		const context: BackgroundContext = {
			db: sql,
			generation: 1,
			drained: Effect.never,
			publicationFence: Ref.get(sequence).pipe(Effect.map((published_through) => ({ published_through }))),
			read: (read) => sql.withTransaction(Ref.get(sequence).pipe(Effect.flatMap(read))),
			mutate: (operation) => (Effect.isEffect(operation) ? sql.withTransaction(operation) : unavailable()),
			emit: (type, payload, change) =>
				sql.withTransaction(
					Effect.gen(function* () {
						const seq = yield* Ref.updateAndGet(sequence, (value) => value + 1);
						if (change) yield* change(seq);
						return {
							seq,
							at: Date.now(),
							type,
							payload,
							level: "info",
							actor: "probe",
							instance: null,
							generation: 1,
							request_id: null,
							topic: null,
							message_id: null,
						};
					}),
				),
			events: {
				query: () => Effect.succeed({ items: [], cursor: 3_000_000_100, timed_out: false, drained: false }),
				changed: unavailable,
			},
			messages: { query: unavailable, create: unavailable },
			topics: { read: unavailable, meta: unavailable, markRead: unavailable },
			log: Object.assign(unavailable, { set: unavailable }),
			kv: () => ({ get: unavailable, set: unavailable, delete: unavailable }),
		};
		type Start = (event: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) => Work<void> | void;
		const starts: Start[] = [];
		const apiFor = (migrate: Api["migrate"]): Api => ({
			migrate,
			context: unavailable,
			effects: {
				report: Effect.succeed({ records: [], overflow: 0 }),
				recordCron: unavailable,
				fetch: unavailable,
				notify: unavailable,
				timer: unavailable,
			},
			mount: () => {},
			page: () => {},
			cron: () => {},
			route: () => {},
			on: (...args) => {
				if (args[0] === "start") starts.push(args[1]);
			},
		});
		const subscriptionApi = apiFor(yield* makeExtensionMigrate(sql, "bundled-probe", "subscriptions"));
		yield* subscriptions(subscriptionApi);
		yield* subscriptions(subscriptionApi);
		// Only execute system's start hook; webhook network delivery is deliberately outside this database test.
		starts.length = 0;
		const systemApi = apiFor(yield* makeExtensionMigrate(sql, "bundled-probe", "system.ts"));
		yield* system(systemApi);
		yield* system(systemApi);
		yield* assertNoPendingMigration(sql);
		assert.equal((yield* sql`SELECT name FROM extension_migrations`).length, 2);
		const who: RequestContext = {
			...context,
			agent: "probe",
			instance: "Instance",
			request: "native-test",
			kind: "agent",
			params: {},
			query: {},
		};
		const store = makeStore(context);
		const input: Input = {
			filter: { types: ["message.created"] },
			deliver: { kind: "webhook", url: "https://example.invalid/hook" },
		};
		const first = yield* store.create(who, input, "CaseKey");
		assert.ok(first.created_at > 2_147_483_647);
		assert.equal(first.since, 3_000_000_000);
		assert.deepEqual(yield* store.create(who, input, "CaseKey"), first);
		const caseKey = yield* store.create(who, input, "casekey");
		assert.notEqual(caseKey.id, first.id);
		const caseInstance = yield* store.create({ ...who, instance: "instance" }, input, "CaseKey");
		assert.notEqual(caseInstance.id, first.id);
		const conflict = yield* store
			.create(who, { ...input, filter: { types: ["message.updated"] } }, "CaseKey")
			.pipe(Effect.result);
		assert.equal(conflict._tag, "Failure");
		if (conflict._tag === "Failure") {
			assert.ok(Schema.is(SubscriptionError)(conflict.failure));
			assert.equal(conflict.failure.code, "idempotency_conflict");
		}
		const row = (yield* store.visible).find((item) => item.id === first.id);
		assert.ok(row);
		yield* store.checkpoint(row, 3_000_000_010, "retry");
		const retried = (yield* store.visible).find((item) => item.id === first.id);
		assert.ok(retried);
		assert.equal(retried.cursor, 3_000_000_010);
		assert.equal(retried.attempts, 1);
		assert.ok(retried.next_attempt > 2_147_483_647);
		yield* store.checkpoint(retried, 3_000_000_005, null);
		const completed = (yield* store.visible).find((item) => item.id === first.id);
		assert.ok(completed);
		assert.equal(completed.cursor, 3_000_000_010);
		assert.equal(completed.attempts, 0);
		assert.equal(completed.next_attempt, 0);
		assert.equal(completed.last_error, null);
		// First insert then update the existing cursor, through the actual running system extension.
		for (const initial of [null, 3_000_000_001]) {
			if (initial !== null) yield* sql`UPDATE system_cursor SET seq=${initial} WHERE id=1`;
			const hook = starts[0];
			assert.ok(hook);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const checkpointed = yield* Deferred.make<void>();
					yield* work(() =>
						hook(
							{ reason: "live" },
							{
								...context,
								events: {
									...context.events,
									changed: () => Deferred.succeed(checkpointed, undefined).pipe(Effect.andThen(Effect.never)),
								},
							},
						),
					);
					yield* Deferred.await(checkpointed).pipe(Effect.timeout("5 seconds"));
					assert.deepEqual(yield* sql`SELECT seq FROM system_cursor WHERE id=1`, [{ seq: 3_000_000_100 }]);
				}).pipe(Effect.timeout("5 seconds")),
			);
		}
		assert.deepEqual(yield* sql`SELECT seq FROM system_cursor`, [{ seq: 3_000_000_100 }]);
	}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(BunServices.layer)),
);
process.stdout.write("BUNDLED_EXTENSIONS_NATIVE_PASSED\n");
