import { preserveMigrationState } from "./migration-state.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { writerGate } from "./database.ts";

/** Migration modules are app-owned code; only the gated child imports them. */
export const migrate = (directory: string, epoch: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
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
						return Effect.isEffect(effect) ? preserveMigrationState(sql, effect) : loaded;
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
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				return yield* Migrator.make({})({ loader, table: "migrations" });
			}),
		);
	});
