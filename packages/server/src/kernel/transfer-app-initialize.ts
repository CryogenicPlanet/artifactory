import { on } from "@comms/storage/dialect";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeForEpoch } from "../ext/core/schema.ts";
import { initializeRemoteKernelSchema } from "./schema.ts";
import { migrate } from "./migrations.ts";
import { transferExtensionMigrations } from "./transfer-extension-migrations.ts";
import { assertNoPendingMigration } from "./migration-intent.ts";
import { writerGate } from "./database.ts";

export class TransferAppInitializationError extends Schema.TaggedError<TransferAppInitializationError>()(
	"TransferAppInitializationError",
	{ code: Schema.Literals(["transfer_source_mismatch", "transfer_epoch_invalid"]) },
) {
	get message() {
		return this.code;
	}
}

const Migration = Schema.Struct({ migration_id: Schema.Int, name: Schema.String });
const ExtensionMigration = Schema.Struct({ extension: Schema.String, name: Schema.String, checksum: Schema.String });

/** Loaded from the frozen source, in an isolated target-app credential worker. The caller
 * owns keeper admission and the incomplete transfer reservation before invoking this.
 * Imports and factories remain trusted arbitrary JavaScript; only managed lifecycle work
 * is excluded here. Migration seed rows are retained for the transfer's explicit copy policy. */
export const initializeTransferApp = (sql: SqlClient.SqlClient, epoch: string, sourceDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!/^[0-9a-f]{64}$/.test(epoch))
			return yield* new TransferAppInitializationError({ code: "transfer_epoch_invalid" });
		const ownSource = yield* fs.realPath(path.resolve(import.meta.dirname, ".."));
		if (sourceDirectory !== ownSource || (yield* fs.realPath(sourceDirectory)) !== sourceDirectory)
			return yield* new TransferAppInitializationError({ code: "transfer_source_mismatch" });
		yield* initializeRemoteKernelSchema(sql, epoch);
		yield* initializeForEpoch(epoch);
		yield* migrate(path.join(sourceDirectory, "migrations"), epoch);
		yield* transferExtensionMigrations(sql, epoch, path.join(sourceDirectory, "ext"));
		yield* assertNoPendingMigration(sql);
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				const hasExtensions = yield* on(sql, {
					sqlite: () =>
						sql`SELECT name FROM sqlite_schema WHERE type='table' AND name='extension_migrations'`.pipe(
							Effect.map((rows) => rows.length === 1),
						),
					pg: () => Effect.succeed(true),
					mysql: () => Effect.succeed(true),
				});
				return {
					core: yield* sql`SELECT migration_id,name FROM core_migrations ORDER BY migration_id`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Migration))),
					),
					editable: yield* sql`SELECT migration_id,name FROM migrations ORDER BY migration_id`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Migration))),
					),
					extensions: hasExtensions
						? yield* sql`SELECT extension,name,checksum FROM extension_migrations ORDER BY extension,name`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExtensionMigration))),
							)
						: [],
				};
			}),
		);
	}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
