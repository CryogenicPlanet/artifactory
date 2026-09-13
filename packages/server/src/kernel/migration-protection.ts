import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { kernelSqlTables, validProtectedTableName } from "./protected-sql-tables.ts";
import { releaseProtectedTables } from "./protection-ownership.ts";

/** Trusted migration declarations follow existing applied-ID semantics: only new IDs execute. */
export const migrationProtection = (sql: SqlClient.SqlClient, loaded: unknown) =>
	Effect.gen(function* () {
		const module = Schema.is(Schema.Struct({ unprotect: Schema.Unknown }))(loaded) ? loaded : undefined;
		if (!module) return Effect.void;
		const names = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(module.unprotect).pipe(
			Effect.mapError(() => new KernelError({ code: "extension_migration_invalid" })),
		);
		if (names.some((name) => !validProtectedTableName(name) || kernelSqlTables.includes(name.toLowerCase())))
			return yield* new KernelError({ code: "extension_migration_invalid" });
		return releaseProtectedTables(sql, names);
	});
