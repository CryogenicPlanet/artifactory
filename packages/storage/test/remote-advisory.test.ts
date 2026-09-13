import { readFile } from "node:fs/promises";
import { Cause, Context, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import type { RemoteConnection } from "../src/remote-session.ts";
import { advisoryClientLayer, directClientLayer } from "../src/remote-client.ts";

const Settings = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});

it.skipIf(!process.env.COMMS_ADVISORY_CONFIG)(
	"owns one writing session across transactions, refuses a competing writer, and releases on disconnect",
	async () => {
		const filename = process.env.COMMS_ADVISORY_CONFIG;
		const engine = process.env.COMMS_ADVISORY_ENGINE;
		if (!filename || (engine !== "pg" && engine !== "mysql")) throw new Error("Missing advisory fixture configuration");
		const config = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
		const connection: RemoteConnection = { ...config, engine, password: Redacted.make(config.password), tls: false };
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					for (const selected of [
						{ ...connection, database: `${config.database}_absent` },
						{ ...connection, username: `${config.username}_absent` },
					]) {
						const result = yield* Effect.scoped(Layer.build(advisoryClientLayer({ connection: selected }))).pipe(
							Effect.exit,
						);
						expect(result._tag).toBe("Failure");
						if (result._tag === "Failure") {
							const text = Cause.pretty(result.cause);
							expect(text).toContain(
								selected.database === connection.database ? "remote_role_rejected" : "remote_database_unavailable",
							);
							expect(text).toContain(selected.database);
							expect(text).toContain(selected.username);
							expect(text).not.toContain(config.password);
						}
					}
					const owner = yield* Scope.make();
					yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
					const services = yield* Layer.build(advisoryClientLayer({ connection })).pipe(
						Effect.provideService(Scope.Scope, owner),
					);
					const sql = Context.get(services, SqlClient);
					const identity = () =>
						sql.unsafe<{ id: number }>(
							engine === "pg" ? "SELECT pg_backend_pid() AS id" : "SELECT CONNECTION_ID() AS id",
						);
					const [row] = yield* identity();
					expect(row?.id).toBeTypeOf("number");
					const ids = yield* Effect.all(
						Array.from({ length: 6 }, () => sql.withTransaction(identity())),
						{ concurrency: 6 },
					);
					expect(ids.every((rows) => rows[0]?.id === row?.id)).toBe(true);
					const rollback = yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* identity();
								return yield* Effect.fail("intentional rollback");
							}),
						)
						.pipe(Effect.result);
					expect(rollback._tag).toBe("Failure");
					const competing = yield* Effect.scoped(Layer.build(advisoryClientLayer({ connection }))).pipe(Effect.exit);
					expect(competing._tag).toBe("Failure");
					if (competing._tag === "Failure") expect(Cause.pretty(competing.cause)).toContain("remote_writer_busy");
					expect((yield* identity())[0]?.id).toBe(row?.id);
					yield* Scope.close(owner, Exit.void);
					const nextOwner = yield* Scope.make();
					yield* Effect.addFinalizer(() => Scope.close(nextOwner, Exit.void));
					const next = Context.get(
						yield* Layer.build(advisoryClientLayer({ connection })).pipe(Effect.provideService(Scope.Scope, nextOwner)),
						SqlClient,
					);
					const [nextId] = yield* next.unsafe<{ id: number }>(
						engine === "pg" ? "SELECT pg_backend_pid() AS id" : "SELECT CONNECTION_ID() AS id",
					);
					expect(nextId?.id).not.toBe(row?.id);
					const id = nextId?.id;
					if (!Number.isSafeInteger(id) || id === undefined) return yield* Effect.die("Invalid session identifier");
					const interruptedCommit = yield* next
						.withTransaction(
							Effect.scoped(
								Effect.gen(function* () {
									const observer = yield* SqlClient;
									if (engine === "pg") yield* observer`SELECT pg_terminate_backend(${id})`;
									else yield* observer.unsafe(`KILL CONNECTION ${id}`);
								}).pipe(Effect.provide(directClientLayer({ connection }))),
							),
						)
						.pipe(Effect.exit);
					expect(interruptedCommit._tag).toBe("Failure");
					for (let attempt = 0; attempt < 2; attempt++) {
						const lost = yield* next.withTransaction(next`SELECT 1`).pipe(Effect.exit);
						expect(lost._tag).toBe("Failure");
					}
					yield* Effect.scoped(
						Effect.gen(function* () {
							const resumed = yield* SqlClient;
							expect(yield* resumed`SELECT 1 AS alive`).toEqual([{ alive: 1 }]);
						}).pipe(Effect.provide(advisoryClientLayer({ connection }))),
					);
				}),
			),
		).catch((error: unknown) => {
			throw new Error(`Advisory acceptance failed: ${error instanceof Error ? error.message : "unknown"}`);
		});
	},
	15000,
);
