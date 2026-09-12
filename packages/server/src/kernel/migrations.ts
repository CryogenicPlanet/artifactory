import { migrationWarnings, observeMigrationDialect } from "./migration-portability.ts";
import { on } from "@comms/storage/dialect";
import { assertNoPendingMigration, mysqlMigration } from "./migration-intent.ts";
import { preserveMigrationState } from "./migration-state.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { writerGate } from "./database.ts";

/** Migration modules are app-owned code; only the gated child imports them. */
export const migrate = (directory: string, epoch: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const warnings = yield* migrationWarnings;
		const unbranched: string[] = [];
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const loader = Effect.gen(function* () {
			// Older source snapshots have no migrations directory.
			if (!(yield* fs.exists(directory))) return [];
			const files = yield* fs.readDirectory(directory);
			const imports: Record<string, () => Promise<unknown>> = {};
			for (const file of files) {
				if (file === "README.md") continue;
				const match = /^(\d+)[_-]([^.]+)\.(ts|js|mts|mjs)$/.exec(file);
				if (
					!match ||
					!match[1] ||
					!match[2] ||
					!match[3] ||
					!Number.isSafeInteger(Number(match[1])) ||
					Number(match[1]) < 1
				)
					return yield* new Migrator.MigrationError({
						kind: "BadState",
						message: `Invalid migration filename: ${file}`,
					});
				const key = `${match[1]}_${match[2]}.${match[3]}`;
				if (imports[key])
					return yield* new Migrator.MigrationError({ kind: "Duplicates", message: `Duplicate migration: ${file}` });
				const url = yield* path.toFileUrl(path.join(directory, file));
				imports[key] = (): Promise<unknown> => import(/* @vite-ignore */ url.href);
			}
			const resolved = yield* Migrator.fromGlob(imports);
			const exported = Schema.is(Schema.Struct({ default: Schema.Unknown }));
			return resolved.map(([id, name, load]): Migrator.ResolvedMigration => [
				id,
				name,
				load.pipe(
					Effect.map((loaded: unknown) => {
						const first = exported(loaded) ? loaded.default : loaded;
						const effect = exported(first) ? first.default : first;
						return Effect.isEffect(effect)
							? preserveMigrationState(
									sql,
									warnings ? observeMigrationDialect(sql, effect, () => unbranched.push(`${id}_${name}`)) : effect,
								)
							: loaded;
					}),
				),
			]);
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof Migrator.MigrationError
					? cause
					: new Migrator.MigrationError({ kind: "Failed", cause, message: "Cannot read app migrations" }),
			),
		);
		const report = warnings
			? Effect.suspend(() => Effect.forEach(unbranched, (name) => warnings.record(name), { discard: true }))
			: Effect.void;
		yield* assertNoPendingMigration(sql);
		if (on(sql, { sqlite: () => false, pg: () => false, mysql: () => true })) {
			const resolved = yield* loader;
			if (new Set(resolved.map(([id]) => id)).size !== resolved.length)
				return yield* new Migrator.MigrationError({ kind: "Duplicates", message: "Duplicate app migration id" });
			const applied = yield* sql`SELECT migration_id FROM migrations ORDER BY migration_id DESC LIMIT 1`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ migration_id: Schema.Int })))),
			);
			if (!resolved.some(([id]) => id > (applied[0]?.migration_id ?? 0))) return [];
			// Migrator may commit receipts before MySQL DDL. The durable intent makes the whole batch untrusted until success.
			return yield* mysqlMigration(
				sql,
				epoch,
				"editable",
				"batch",
				Migrator.make({})({ loader: Effect.succeed(resolved), table: "migrations" }),
				Effect.void,
			).pipe(Effect.tap(() => report));
		}
		return yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, epoch);
					return yield* Migrator.make({})({ loader, table: "migrations" });
				}),
			)
			.pipe(Effect.tap(() => report));
	});
