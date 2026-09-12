import { Effect, Schema } from "effect";
import { indexShape, tableShape, type ColumnShape } from "@comms/storage/remote-migrations";
import { EventError } from "./events.ts";
import { on } from "@comms/storage/dialect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

const invalid = () => new EventError({ code: "app_store_identity_invalid" });
const booleans = Schema.Array(Schema.Struct({ valid: Schema.Int }));
const numeric = (name: string, type = "bigint", nullable = false): ColumnShape => ({ name, type, nullable });

/** Caller journals each operation before executing it, after positive closure and authoritative store selection.
 * PostgreSQL tables belong to boot's login. MySQL access is provisioner-owned; table ownership is not equivalent. */
export const remoteAppKernelOperations = (sql: SqlClient.SqlClient, appRole: string) => {
	const engine = on(sql, { sqlite: () => "sqlite", pg: () => "pg", mysql: () => "mysql" });
	if (engine === "sqlite") return [];
	const validPrincipal: Effect.Effect<void, EventError> = appRole ? Effect.void : Effect.fail(invalid());
	const text = (name: string, nullable = false, mysqlType = "text", length?: number): ColumnShape => ({
		name,
		type: engine === "pg" ? "text" : mysqlType,
		nullable,
		...(engine === "mysql" && length !== undefined ? { length } : {}),
	});
	const owned = (table: string) =>
		engine === "pg"
			? sql`SELECT CASE WHEN pg_get_userbyid(c.relowner)=session_user AND current_user=session_user THEN 1 ELSE 0 END AS valid
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=${table} AND c.relkind='r'`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(booleans)),
					Effect.flatMap((rows) => (rows.length === 1 && rows[0]?.valid === 1 ? Effect.void : Effect.fail(invalid()))),
				)
			: Effect.void;
	const table = (
		name: string,
		run: Effect.Effect<unknown, SqlError>,
		columns: readonly ColumnShape[],
		key: string,
		singleton = false,
	) => ({
		name: `table:${name}`,
		run: validPrincipal.pipe(Effect.andThen(run), Effect.asVoid),
		postcondition: Effect.gen(function* () {
			yield* validPrincipal;
			const exists = yield* tableShape(
				sql,
				name,
				columns.map((column) => ({
					...column,
					default: null,
					expression: engine === "pg" ? null : "",
					identity: false,
					identityGeneration: null,
					collation:
						engine === "mysql" && ["text", "longtext", "varchar"].includes(column.type) ? "utf8mb4_0900_bin" : null,
				})),
				[key],
				{
					foreignKeys: [],
					checks: singleton ? [engine === "pg" ? "(singleton = 1)" : "(`singleton` = 1)"] : [],
				},
			);
			if (!exists) return false;
			yield* owned(name);
			return true;
		}),
	});
	const tables = [
		table(
			"kernel_writer",
			engine === "pg"
				? sql`CREATE TABLE public.kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL)`
				: sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			[numeric("singleton", engine === "pg" ? "integer" : "int"), text("epoch")],
			"singleton",
			true,
		),
		table(
			"mutation_batches",
			engine === "pg"
				? sql`CREATE TABLE public.mutation_batches(id TEXT PRIMARY KEY,from_seq BIGINT NOT NULL,to_seq BIGINT NOT NULL,count BIGINT NOT NULL)`
				: sql`CREATE TABLE mutation_batches(id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY,from_seq BIGINT NOT NULL,to_seq BIGINT NOT NULL,count BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			[text("id", false, "varchar", 255), numeric("from_seq"), numeric("to_seq"), numeric("count")],
			"id",
		),
		table(
			"outbox",
			engine === "pg"
				? sql`CREATE TABLE public.outbox(seq BIGINT PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)`
				: sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,event LONGTEXT NOT NULL,shipped_at BIGINT) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			[
				numeric("seq"),
				text("transaction_id", false, "varchar", 255),
				text("event", false, "longtext"),
				numeric("shipped_at", "bigint", true),
			],
			"seq",
		),
		table(
			"store_identity",
			engine === "pg"
				? sql`CREATE TABLE public.store_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at BIGINT NOT NULL,transferred_to TEXT)`
				: sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id VARCHAR(36) NOT NULL,initialized_at BIGINT NOT NULL,transferred_to TEXT) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			[
				numeric("singleton", engine === "pg" ? "integer" : "int"),
				text("store_id", false, "varchar", 36),
				numeric("initialized_at"),
				text("transferred_to", true),
			],
			"singleton",
			true,
		),
	];
	const indexes = [
		{ name: "outbox_unshipped", columns: ["shipped_at", "seq"] },
		{ name: "outbox_transaction", columns: ["transaction_id", "seq"] },
	].map(({ name, columns }) => ({
		name: `index:${name}`,
		run: validPrincipal.pipe(
			Effect.andThen(
				engine === "pg"
					? sql`CREATE INDEX ${sql(name)} ON public.outbox (${sql.join(",", false)(columns.map((column) => sql`${sql(column)}`))})`
					: sql`CREATE INDEX ${sql(name)} ON outbox (${sql.join(",", false)(columns.map((column) => sql`${sql(column)}`))})`,
			),
			Effect.asVoid,
		),
		postcondition: Effect.gen(function* () {
			yield* validPrincipal;
			const exists = yield* indexShape(sql, "outbox", name, columns, false);
			if (!exists) return false;
			yield* owned("outbox");
			return true;
		}),
	}));
	const grant = (name: string, names: readonly string[], permissions: readonly string[]) => ({
		name: `grant:${name}`,
		run: validPrincipal.pipe(
			Effect.andThen(
				Effect.gen(function* () {
					for (const name of names)
						yield* sql`GRANT ${sql.join(",", false)(permissions)} ON public.${sql(name)} TO ${sql(appRole)}`;
				}),
			),
		),
		postcondition: Effect.gen(function* () {
			yield* validPrincipal;
			for (const name of names) {
				if (!(yield* tables.find((table) => table.name === `table:${name}`)?.postcondition ?? Effect.succeed(false)))
					return false;
				for (const permission of permissions) {
					const allowed =
						yield* sql`SELECT CASE WHEN has_table_privilege(${appRole},${`public.${name}`},${permission}) THEN 1 ELSE 0 END AS valid`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(booleans)),
						);
					if (allowed[0]?.valid !== 1) return false;
				}
				if (engine === "pg") {
					// Include column grants, PUBLIC and memberships whose privileges the app can activate with SET ROLE.
					const excess = yield* sql`SELECT CASE WHEN EXISTS(
 SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL (
 SELECT grantee,privilege_type,is_grantable FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner)))
 UNION ALL SELECT acl.grantee,acl.privilege_type,acl.is_grantable
 FROM pg_catalog.pg_attribute attribute CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
 WHERE attribute.attrelid=c.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
) a
 WHERE n.nspname='public' AND c.relname=${name}
 AND CASE WHEN a.grantee=0 THEN true ELSE pg_has_role(${appRole},a.grantee,'MEMBER') END
 AND (a.is_grantable OR NOT (${sql.in("privilege_type", permissions)}))) THEN 1 ELSE 0 END AS valid`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(booleans)),
					);
					if (excess[0]?.valid !== 0) return yield* invalid();
				}
			}
			return true;
		}),
	});
	return [
		...tables,
		...indexes,
		...(engine === "mysql"
			? [
					table(
						"kernel_migration_intent",
						sql`CREATE TABLE kernel_migration_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,epoch VARCHAR(128) NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
						[
							numeric("singleton", "int"),
							text("scope", false, "varchar", 255),
							text("name", false, "varchar", 255),
							text("epoch", false, "varchar", 128),
						],
						"singleton",
						true,
					),
				]
			: [
					grant(
						"kernel_dml",
						["kernel_writer", "mutation_batches", "outbox"],
						["SELECT", "INSERT", "UPDATE", "DELETE"],
					),
					grant("identity_read", ["store_identity"], ["SELECT"]),
				]),
	];
};

/** Compatibility for isolated schema fixtures; production uses the named, journaled operations above. */
export const remoteAppKernelSchema = (sql: SqlClient.SqlClient, appRole: string) =>
	remoteAppKernelOperations(sql, appRole).map((operation) =>
		Effect.gen(function* () {
			if (yield* operation.postcondition) return;
			yield* operation.run;
			if (!(yield* operation.postcondition)) return yield* invalid();
		}),
	);
