import type { RemoteStore } from "@comms/storage/store";
import { Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RemoteDatabaseError, type RemoteDatabaseRecord } from "./remote-database-journal.ts";

const invalid = () => new RemoteDatabaseError({ code: "remote_database_invalid" });
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const stamp = (record: RemoteDatabaseRecord) => `comms-resource:${record.id}`;
const Credentials = (store: RemoteStore) =>
	Effect.try({
		try: () => {
			const url = new URL(Redacted.value(store.url));
			return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
		},
		catch: invalid,
	});

/** Call only with the guarded boot SQL client. These statements never pass through SQL tracing. */
export const postgresDatabaseProvision = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const execute = (statement: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				const transaction = yield* Effect.serviceOption(sql.transactionService);
				const connection = Option.isSome(transaction) ? transaction.value[0] : yield* sql.reserve;
				yield* connection.executeUnprepared(statement, [], undefined);
			}),
		).pipe(Effect.mapError(() => new RemoteDatabaseError({ code: "remote_database_provision_failed" })));
	const validate = (record: RemoteDatabaseRecord, credential: RemoteStore) =>
		Effect.gen(function* () {
			const credentials = yield* Credentials(credential);
			if (
				credential._tag !== "postgres" ||
				credential.database !== record.database ||
				credentials.username !== record.principal ||
				!/^[0-9a-f]{64}$/.test(credentials.password) ||
				record.phase !== "allocated"
			)
				return yield* invalid();
			return credentials;
		});
	const createPrincipal = (record: RemoteDatabaseRecord, credential: RemoteStore) =>
		Effect.gen(function* () {
			const credentials = yield* validate(record, credential);
			if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return yield* invalid();
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* execute(
						`CREATE ROLE ${identifier(record.principal)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(credentials.password)}`,
					);
					yield* execute(`COMMENT ON ROLE ${identifier(record.principal)} IS ${literal(stamp(record))}`);
					yield* execute(`GRANT ${identifier(record.principal)} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
				}),
			);
		});
	const createDatabase = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			if (
				record.kind === "dump" ||
				record.phase !== "allocated" ||
				Option.isSome(yield* Effect.serviceOption(sql.transactionService))
			)
				return yield* invalid();
			// CREATE DATABASE cannot be transactional. If the following receipt fails, retain the orphan.
			yield* execute(`CREATE DATABASE ${identifier(record.database)} TEMPLATE template0 ENCODING 'UTF8'`);
			yield* execute(`COMMENT ON DATABASE ${identifier(record.database)} IS ${literal(stamp(record))}`);
			yield* execute(`REVOKE ALL ON DATABASE ${identifier(record.database)} FROM PUBLIC`);
			yield* execute(
				`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${identifier(record.database)} TO ${identifier(record.principal)}`,
			);
		});
	/** Run through withStore on the newly created database, before its restricted loader starts. */
	const grantSchema = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT current_database() AS database`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ database: Schema.String })))),
			);
			if (rows[0]?.database !== record.database) return yield* invalid();
			yield* execute("ALTER SCHEMA public OWNER TO CURRENT_USER");
			yield* execute("REVOKE ALL ON SCHEMA public FROM PUBLIC");
			yield* execute(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(record.principal)}`);
		});
	const provePrincipal = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			const rows =
				yield* sql`SELECT shobj_description(oid,'pg_authid') AS stamp FROM pg_roles WHERE rolname=${record.principal}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ stamp: Schema.NullOr(Schema.String) }))),
					),
				);
			if (rows.length > 1 || (rows.length === 1 && rows[0]?.stamp !== stamp(record))) return yield* invalid();
			return rows.length === 1;
		});
	/** Caller must first obtain independent positive account/process closure. No failed load auto-drops. */
	const dropRehearsal = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			if (record.kind !== "rehearsal" || record.phase !== "closed") return yield* invalid();
			const principalExists = yield* provePrincipal(record);
			const rows =
				yield* sql`SELECT shobj_description(oid,'pg_database') AS stamp FROM pg_database WHERE datname=${record.database}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ stamp: Schema.NullOr(Schema.String) }))),
					),
				);
			if (rows.length > 1 || (rows.length === 1 && rows[0]?.stamp !== stamp(record))) return yield* invalid();
			if (rows.length === 1) yield* execute(`DROP DATABASE ${identifier(record.database)}`);
			if (principalExists) yield* execute(`DROP ROLE ${identifier(record.principal)}`);
		});
	const protectKernel = (record: RemoteDatabaseRecord, appRole = record.principal) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT current_database() AS database`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ database: Schema.String })))),
			);
			if (rows[0]?.database !== record.database) return yield* invalid();
			for (const table of ["kernel_writer", "mutation_batches", "outbox", "store_identity"])
				yield* execute(`ALTER TABLE public.${identifier(table)} OWNER TO CURRENT_USER`);
			yield* execute(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON public.kernel_writer, public.mutation_batches, public.outbox TO ${identifier(appRole)}`,
			);
			yield* execute(`GRANT SELECT ON public.store_identity TO ${identifier(appRole)}`);
		});
	const handoff = (record: RemoteDatabaseRecord, appRole: string) =>
		Effect.gen(function* () {
			if (record.kind !== "restore" || record.phase !== "ready") return yield* invalid();
			yield* provePrincipal(record);
			const selected = yield* sql`SELECT current_database() AS database`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ database: Schema.String })))),
			);
			if (selected[0]?.database !== record.database) return yield* invalid();
			yield* execute(`REASSIGN OWNED BY ${identifier(record.principal)} TO ${identifier(appRole)}`);
			yield* protectKernel(record, appRole);
			yield* execute(
				`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${identifier(record.database)} TO ${identifier(appRole)}`,
			);
			yield* execute(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(appRole)}`);
			yield* execute(`DROP OWNED BY ${identifier(record.principal)}`);
		});
	const grantDump = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			if (record.kind !== "dump" || record.phase !== "allocated") return yield* invalid();
			const selected = yield* sql`SELECT current_database() AS database`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ database: Schema.String })))),
			);
			if (selected[0]?.database !== record.database) return yield* invalid();
			yield* execute(`GRANT CONNECT ON DATABASE ${identifier(record.database)} TO ${identifier(record.principal)}`);
			const schemas =
				yield* sql`SELECT nspname AS name FROM pg_namespace WHERE left(nspname,3) <> 'pg_' AND nspname <> 'information_schema'`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))),
				);
			for (const schema of schemas) {
				yield* execute(`GRANT USAGE ON SCHEMA ${identifier(schema.name)} TO ${identifier(record.principal)}`);
				yield* execute(
					`GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(schema.name)} TO ${identifier(record.principal)}`,
				);
				yield* execute(
					`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${identifier(schema.name)} TO ${identifier(record.principal)}`,
				);
			}
		});
	/** Execute on the source for a dump; restore handoff already removed target grants. */
	const revokeDump = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			if (record.kind !== "dump" || record.phase !== "closed") return yield* invalid();
			const selected = yield* sql`SELECT current_database() AS database`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ database: Schema.String })))),
			);
			if (selected[0]?.database !== record.database) return yield* invalid();
			if (yield* provePrincipal(record)) yield* execute(`DROP OWNED BY ${identifier(record.principal)}`);
		});
	const dropPrincipal = (record: RemoteDatabaseRecord) =>
		Effect.gen(function* () {
			if (record.phase !== "closed") return yield* invalid();
			if (yield* provePrincipal(record)) yield* execute(`DROP ROLE ${identifier(record.principal)}`);
		});
	return {
		createPrincipal,
		createDatabase,
		grantSchema,
		protectKernel,
		handoff,
		grantDump,
		revokeDump,
		dropPrincipal,
		dropRehearsal,
	};
});
