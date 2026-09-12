import { Effect, Exit, Redacted, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { mysqlDatabaseProvision } from "../src/mysql-database-provision.ts";
import { RemoteDatabaseError, type RemoteDatabaseRecord } from "../src/remote-database-journal.ts";

const record = (kind: RemoteDatabaseRecord["kind"] = "rehearsal"): RemoteDatabaseRecord => ({
	id: "01234567-89ab-4cde-8123-456789abcdef",
	kind,
	endpoint: "mysql://localhost:3306",
	database: `comms_${kind === "restore" ? "app" : "rehearsal"}_0123456789ab4cde8123456789abcdef`,
	principal: "comms_t_0123456789ab4cde81234567",
	phase: "allocated",
});
const fixture = (rows: (statement: string) => readonly object[] = () => []) =>
	Effect.gen(function* () {
		const commands: string[] = [];
		const execute = (statement: string) =>
			Effect.sync(() => {
				commands.push(statement);
				return rows(statement);
			});
		const sql = yield* SqlClient.make({
			acquirer: Effect.succeed({
				execute,
				executeRaw: execute,
				executeUnprepared: execute,
				executeValues: () => Effect.succeed([]),
				executeValuesUnprepared: () => Effect.succeed([]),
				executeStream: () => Stream.empty,
			}),
			compiler: Statement.makeCompiler({
				dialect: "mysql",
				placeholder: () => "?",
				onIdentifier: (value) => value,
				onRecordUpdate: () => {
					throw Error("Unused");
				},
				onCustom: () => {
					throw Error("Unused");
				},
			}),
			spanAttributes: [],
		});
		return { sql, commands };
	});
const run = <A, E>(effect: Effect.Effect<A, E, Reactivity.Reactivity>) =>
	Effect.runPromise(effect.pipe(Effect.provide(Reactivity.layer), Effect.scoped));

it("never deletes a restore target or unreceipted scratch database", async () => {
	for (const kind of ["restore", "rehearsal"] as const)
		await run(
			Effect.gen(function* () {
				const { sql, commands } = yield* fixture();
				const provision = yield* mysqlDatabaseProvision({
					created: () => Effect.void,
					owns: () => Effect.succeed(false),
				}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
				const exit = yield* provision.dropRehearsal({ ...record(kind), phase: "closed" }).pipe(Effect.exit);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(commands).toEqual([]);
			}),
		);
});

it("retains an exclusively created database if its durable receipt fails", async () =>
	run(
		Effect.gen(function* () {
			const resource = record();
			const { sql, commands } = yield* fixture((statement) =>
				statement.includes("USER_ATTRIBUTES") ? [{ host: "%", stamp: resource.id }] : [],
			);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.fail(new RemoteDatabaseError({ code: "remote_database_cleanup_required" })),
				owns: () => Effect.succeed(false),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			expect(Exit.isFailure(yield* provision.createDatabase(resource).pipe(Effect.exit))).toBe(true);
			expect(commands.filter((text) => text.startsWith("CREATE DATABASE"))).toHaveLength(1);
			expect(commands.some((text) => text.startsWith("GRANT") || text.startsWith("DROP"))).toBe(false);
		}),
	));

it("refuses existing accounts at another host before creating any credential", async () =>
	run(
		Effect.gen(function* () {
			const resource = record();
			const { sql, commands } = yield* fixture(() => [{ HOST: "localhost" }]);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.void,
				owns: () => Effect.succeed(false),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			const exit = yield* provision
				.createPrincipal(resource, {
					_tag: "mysql",
					database: resource.database,
					url: Redacted.make(`mysql://${resource.principal}:${"a".repeat(64)}@localhost/${resource.database}`),
				})
				.pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(commands.some((text) => text.startsWith("CREATE USER"))).toBe(false);
		}),
	));

it("refuses advanced objects before giving a dump principal source access", async () =>
	run(
		Effect.gen(function* () {
			const resource = record("dump");
			const { sql, commands } = yield* fixture((statement) =>
				statement.includes("DATABASE()")
					? [{ name: resource.database }]
					: statement.includes("CURRENT_USER()")
						? [{ account: "boot@%", partial_revokes: 0 }]
						: statement.includes("SCHEMA_PRIVILEGES")
							? ["SELECT", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE"].map((privilege) => ({
									pattern: resource.database,
									privilege,
								}))
							: [{ name: "definer_view" }],
			);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.void,
				owns: () => Effect.succeed(false),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			expect(Exit.isFailure(yield* provision.grantDump(resource).pipe(Effect.exit))).toBe(true);
			expect(commands.some((text) => text.startsWith("GRANT"))).toBe(false);
		}),
	));

it("refuses a principal with a mismatched atomic ownership attribute before database deletion", async () =>
	run(
		Effect.gen(function* () {
			const { sql, commands } = yield* fixture(() => [{ host: "%", stamp: "another owner" }]);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.void,
				owns: () => Effect.succeed(true),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			expect(Exit.isFailure(yield* provision.dropRehearsal({ ...record(), phase: "closed" }).pipe(Effect.exit))).toBe(
				true,
			);
			expect(commands.some((text) => text.startsWith("DROP"))).toBe(false);
		}),
	));

it("refuses incomplete catalog visibility before inspecting objects or granting source access", async () =>
	run(
		Effect.gen(function* () {
			const resource = record("dump");
			const { sql, commands } = yield* fixture((statement) =>
				statement.includes("DATABASE()")
					? [{ name: resource.database }]
					: statement.includes("CURRENT_USER()")
						? [{ account: "boot@%", partial_revokes: 0 }]
						: [{ pattern: resource.database, privilege: "SELECT" }],
			);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.void,
				owns: () => Effect.succeed(false),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			expect(Exit.isFailure(yield* provision.grantDump(resource).pipe(Effect.exit))).toBe(true);
			expect(commands.some((text) => text.includes("information_schema.VIEWS") || text.startsWith("GRANT"))).toBe(
				false,
			);
		}),
	));

it("delegates only the generated exact database after its successful creation receipt", async () =>
	run(
		Effect.gen(function* () {
			const resource = record();
			const { sql, commands } = yield* fixture((statement) =>
				statement.includes("USER_ATTRIBUTES") ? [{ host: "%", stamp: resource.id }] : [],
			);
			const provision = yield* mysqlDatabaseProvision({
				created: () =>
					Effect.sync(() => {
						commands.push("durable receipt");
					}),
				owns: () => Effect.succeed(true),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			yield* provision.createDatabase(resource);
			const receipt = commands.indexOf("durable receipt");
			expect(commands[receipt - 1]).toContain("CREATE DATABASE");
			expect(commands[receipt + 1]).toContain("ON `comms\\_rehearsal\\_0123456789ab4cde8123456789abcdef`.*");
			expect(commands[receipt + 1]).not.toContain("GRANT OPTION");
			expect(commands[receipt + 1]).not.toContain("TRIGGER");
		}),
	));

it("does not combine catalog privileges from competing MySQL wildcard grants", async () =>
	run(
		Effect.gen(function* () {
			const resource = record("dump");
			const { sql, commands } = yield* fixture((statement) =>
				statement.includes("DATABASE()")
					? [{ name: resource.database }]
					: statement.includes("CURRENT_USER()")
						? [{ account: "boot@%", partial_revokes: 0 }]
						: ["SELECT", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE"].map((privilege, index) => ({
								pattern: index === 0 ? "comms_%" : "comms_rehearsal_%",
								privilege,
							})),
			);
			const provision = yield* mysqlDatabaseProvision({
				created: () => Effect.void,
				owns: () => Effect.succeed(false),
			}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
			expect(Exit.isFailure(yield* provision.grantDump(resource).pipe(Effect.exit))).toBe(true);
			expect(commands.some((text) => text.includes("information_schema.VIEWS") || text.startsWith("GRANT"))).toBe(
				false,
			);
		}),
	));
