import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { testStore } from "./test-store.ts";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { remoteAppKernelOperations } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";

/** Publication protocol only: actual schema and scoped stores, no keeper/role ownership claim.
 * Remote databases must be fresh and exclusively allocated; retain them for inspection. */
export const portablePublicationStore = (options: {
	readonly engine: "sqlite" | "pglite" | "pg" | "mysql";
	readonly appConfig: string | undefined;
	readonly bootConfig: string | undefined;
	readonly appDatabase: string;
	readonly bootDatabase: string;
}) =>
	Effect.gen(function* () {
		const bootSql = yield* testStore({
			engine: options.engine,
			config: options.bootConfig,
			database: options.bootDatabase,
			tables: [],
		});
		const sql = yield* testStore({
			engine: options.engine,
			config: options.appConfig,
			database: options.appDatabase,
			tables: [],
		});
		yield* initializeBootSchema.pipe(Effect.provideService(SqlClient, bootSql));
		const events = Context.get(
			yield* Layer.build(eventsLayer(Effect.void).pipe(Layer.provide(Layer.succeed(SqlClient, bootSql)))),
			Events,
		);
		const epoch = "portable-publication";
		if (options.engine === "sqlite") {
			// Exact three kernel tables from app-recovery's SQLite initializer, whose
			// file identity/adoption workflow is intentionally outside this in-memory test.
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`;
			yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)`;
			yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)`;
		} else {
			for (const operation of remoteAppKernelOperations(sql, "fixture")) {
				if (!operation.name.startsWith("grant:")) yield* operation.run;
			}
		}
		yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
		const unavailable = () => new KernelError({ code: "boot_unavailable" });
		const channel: BootChannel["Service"] = {
			epoch,
			generation: 1,
			filename: null,
			// No file operations are exposed by this direct service fixture.
			store: { _tag: "file", filename: "/unused/portable-publication.db" },
			backup: Effect.die("Unexpected backup in publication fixture"),
			changed: (after) => events.changed(after).pipe(Effect.mapError(unavailable)),
			fence: events.state.pipe(
				Effect.map(({ published_through }) => ({ published_through })),
				Effect.mapError(unavailable),
			),
			events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
			reserve: (transaction, count) => events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable)),
			append: (batch) => events.append(batch, epoch).pipe(Effect.mapError(unavailable)),
			abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
		};
		yield* initializeRemoteKernelSchema(sql, epoch);
		yield* initialize.pipe(Effect.provideService(SqlClient, sql), Effect.provideService(BootChannel, channel));
		return { sql, bootSql, events, channel };
	});
