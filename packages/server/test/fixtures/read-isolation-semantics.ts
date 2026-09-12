import { strict as assert } from "node:assert";
import { Effect, Schema, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "@comms/storage/dialect";
import { makeReadSnapshot } from "../../src/kernel/read-snapshot.ts";
import { extensionData } from "../../src/kernel/extension-data.ts";
import { Publication } from "../../src/kernel/publication.ts";
import { layer as healthLayer } from "../../src/kernel/health-probe.ts";
import { layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { SqlClient as SqlService } from "effect/unstable/sql/SqlClient";

export const readIsolationSemantics = (sql: SqlClient) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE kernel_writer(epoch VARCHAR(200))`;
		yield* sql`INSERT INTO kernel_writer VALUES('fixture')`;
		yield* sql`CREATE TABLE kv(ns VARCHAR(200),${sql("key")} VARCHAR(200),value TEXT,previous TEXT,updated_seq BIGINT)`;
		yield* sql`INSERT INTO kv VALUES('fixture','key','{"live":true}','{"live":false}',30)`;
		const fence = Effect.gen(function* () {
			const rows = yield* on(sql, {
				sqlite: () => sql`SELECT 'repeatable read' AS isolation`,
				pg: () => sql`SELECT current_setting('transaction_isolation') AS isolation`,
				mysql: () => sql`SELECT LOWER(REPLACE(@@transaction_isolation,'-',' ')) AS isolation`,
			}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ isolation: Schema.String })))));
			assert.equal(rows[0]?.isolation, "repeatable read");
			return { published_through: 20 };
		});
		const { read } = yield* makeReadSnapshot(
			sql,
			"fixture",
			yield* Semaphore.make(1),
			fence,
			Effect.void,
			yield* Effect.scope,
		);
		assert.equal(
			yield* read((ceiling) => read((nested) => Effect.succeed(ceiling + nested))).pipe(Effect.provide(healthLayer)),
			40,
		);
		// Only the cached fence is needed by kv.get; unused publication operations fail if accidentally invoked.
		const unused = () => Effect.die("Unexpected publication operation in read fixture");
		const publication: Publication["Service"] = {
			wake: Effect.void,
			runRelay: unused,
			mutate: unused,
			read: unused,
			fence,
			writeSql: unused,
			change: unused,
			recordEvent: unused,
			relay: Effect.succeed(undefined),
			quiesce: Effect.void,
			changed: unused,
		};
		const data = yield* extensionData.pipe(
			Effect.provideService(SqlService, sql),
			Effect.provideService(Publication, publication),
			Effect.provide(lifecycleLayer),
		);
		assert.deepEqual(yield* data("fixture").kv().get("key"), { live: false });
	});
