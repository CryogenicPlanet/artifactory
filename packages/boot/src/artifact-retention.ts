import { Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { readStoragePolicy } from "./settings-schema.ts";
import { BackupRecord } from "./backup-metadata.ts";
import type { StorageVolume } from "./storage-volume.ts";

export class ArtifactRetentionRejected extends Schema.TaggedError<ArtifactRetentionRejected>()(
	"ArtifactRetentionRejected",
	{
		code: Schema.Literals(["backup_budget", "invalid_storage_sample", "unsafe_artifact_path"]),
	},
) {}

const Generation = Schema.Struct({
	n: Schema.Int,
	snapshot_dir: Schema.NullOr(Schema.String),
	backup_id: Schema.NullOr(Schema.String),
});
const Protected = Schema.Struct({ n: Schema.Int });
const BackupId = Schema.Struct({ id: Schema.String });

/** Call under supervisor.operationGate, including when reserving space before a copy.
 * Run at stable boundaries, never between reserving a generation and registering its child
 * attempt in the same operation. Active and prewarmed children have an unclosed attempt;
 * persisted live/starting labels can outlive their processes and are not ownership evidence.
 * operationGenerations keeps every generation the current operation may need after
 * closing its attempt (including a fallback older than the last five good snapshots).
 * Only catalogued boot-owned artifacts are considered; this is not a volume scanner.
 * File removal precedes catalog removal so a crash leaves a retryable missing-file row.
 */
export const artifactRetention = (directory: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const sync = (name: string) => Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
		const remove = (root: string, relative: string, recursive: boolean) =>
			Effect.gen(function* () {
				// Check each ancestor, including a dangling symlink, without traversing contents.
				let current = root;
				for (const part of relative.split(path.sep)) {
					current = path.join(current, part);
					const resolved = yield* fs.realPath(current).pipe(
						Effect.catchIf(
							(error) => error.reason._tag === "NotFound",
							() =>
								fs.readLink(current).pipe(
									Effect.flatMap(() => Effect.fail(new ArtifactRetentionRejected({ code: "unsafe_artifact_path" }))),
									Effect.catchIf(
										(linkError) => linkError._tag === "PlatformError" && linkError.reason._tag === "NotFound",
										() => Effect.succeed(null),
									),
								),
						),
					);
					if (resolved === null) {
						// A previous unlink may have succeeded before its sync failed. Confirm
						// durable absence before dropping the only catalogue reference.
						yield* sync(path.dirname(current));
						return false;
					}
					if (resolved !== current) return yield* new ArtifactRetentionRejected({ code: "unsafe_artifact_path" });
				}
				const info = yield* fs.stat(current);
				if (info.type !== (recursive ? "Directory" : "File"))
					return yield* new ArtifactRetentionRejected({ code: "unsafe_artifact_path" });
				yield* fs.remove(current, { recursive });
				yield* sync(path.dirname(current));
				return true;
			});
		return {
			prune: (volume: StorageVolume, requiredBackupBytes: number, operationGenerations: readonly number[]) =>
				Effect.gen(function* () {
					const policy = yield* readStoragePolicy.pipe(Effect.provideService(SqlClient.SqlClient, sql));
					const root = yield* fs.realPath(directory);
					if (
						!Number.isSafeInteger(requiredBackupBytes) ||
						requiredBackupBytes < 0 ||
						(volume.status === "available" &&
							(!Number.isSafeInteger(volume.capacity_bytes) || volume.capacity_bytes <= 0))
					)
						return yield* new ArtifactRetentionRejected({ code: "invalid_storage_sample" });
					if (volume.status !== "available" && requiredBackupBytes > 0)
						return yield* new ArtifactRetentionRejected({ code: "invalid_storage_sample" });
					const catalog = yield* sql.withTransaction(
						Effect.gen(function* () {
							const generations = yield* sql`SELECT n,snapshot_dir,backup_id FROM generations ORDER BY n`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Generation))),
							);
							const protectedGenerations = yield* sql`
							SELECT n FROM (SELECT n FROM generations WHERE good=1 ORDER BY n DESC LIMIT 5)
							-- Attempt closure, not a historical live label, identifies current filesystem owners.
							UNION SELECT generation AS n FROM child_attempts WHERE closed=0
							UNION SELECT candidate AS n FROM cutover
							UNION SELECT prior AS n FROM cutover WHERE prior IS NOT NULL
							UNION SELECT source_generation AS n FROM db_restore_requests
 WHERE source_generation IS NOT NULL AND (phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL)
 UNION SELECT prior_generation AS n FROM db_restore_requests
 WHERE prior_generation IS NOT NULL AND (phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL)
 UNION SELECT generation AS n FROM db_restore_requests
							WHERE generation IS NOT NULL AND (phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL)
						`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Protected))));
							const protectedBackups = yield* sql`
							SELECT backup AS id FROM cutover WHERE backup IS NOT NULL
							UNION SELECT backup AS id FROM db_restore_requests
							WHERE phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL
							UNION SELECT safety_backup AS id FROM db_restore_requests WHERE safety_backup IS NOT NULL
							AND (phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL)
						`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupId))));
							const backups = yield* sql`SELECT * FROM backups
							ORDER BY CASE WHEN reason='hourly' THEN 0 WHEN reason='manual' THEN 1 ELSE 2 END,taken_at,id`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupRecord))),
							);
							return { generations, protectedGenerations, protectedBackups, backups };
						}),
					);
					const protectedGenerations = new Set([
						...catalog.protectedGenerations.map((item) => item.n),
						...operationGenerations,
					]);
					const protectedBackups = new Set(catalog.protectedBackups.map((item) => item.id));
					for (const generation of catalog.generations) {
						if (protectedGenerations.has(generation.n) && generation.backup_id !== null)
							protectedBackups.add(generation.backup_id);
					}
					let removedGenerations = 0;
					for (const generation of catalog.generations) {
						if (protectedGenerations.has(generation.n)) continue;
						if (!Number.isSafeInteger(generation.n) || generation.n < 1) continue;
						const relative = path.join("gen", String(generation.n));
						// Null is an interrupted reservation. Unknown legacy locations are never inferred.
						if (
							generation.snapshot_dir !== null &&
							generation.snapshot_dir !== path.join(directory, relative, "source") &&
							generation.snapshot_dir !== path.join(root, relative, "source")
						)
							continue;
						if (yield* remove(root, relative, true)) removedGenerations++;
						// Preserve generation history without advertising a snapshot that no longer exists.
						yield* sql`UPDATE generations SET snapshot_dir=NULL WHERE n=${generation.n}`;
					}
					let backupBytes = 0;
					for (const backup of catalog.backups) {
						if (
							!Number.isSafeInteger(backup.bytes) ||
							backup.bytes < 0 ||
							!Number.isSafeInteger(backupBytes + backup.bytes)
						)
							return yield* new ArtifactRetentionRejected({ code: "invalid_storage_sample" });
						backupBytes += backup.bytes;
					}
					const limit =
						volume.status === "available" ? Math.floor(volume.capacity_bytes * (policy.backup_percent / 100)) : null;
					let removedBackups = 0;
					for (const backup of catalog.backups) {
						if (limit === null || backupBytes + requiredBackupBytes <= limit) break;
						if (
							protectedBackups.has(backup.id) ||
							backup.published_through === null ||
							backup.generation === null ||
							(backup.reason !== "hourly" &&
								backup.reason !== "manual" &&
								backup.reason !== "pre-flip" &&
								backup.reason !== "pre-restore") ||
							((backup.reason === "pre-flip" || backup.reason === "pre-restore") &&
								protectedGenerations.has(backup.generation))
						)
							continue;
						if (!/^[A-Za-z0-9_-]+$/.test(backup.id)) continue;
						const relative = path.join("backups", `${backup.id}.db`);
						if (backup.path !== path.join(directory, relative) && backup.path !== path.join(root, relative)) continue;
						yield* remove(root, relative, false);
						yield* sql`DELETE FROM backups WHERE id=${backup.id}`;
						backupBytes -= backup.bytes;
						removedBackups++;
					}
					if (limit !== null && backupBytes + requiredBackupBytes > limit)
						return yield* new ArtifactRetentionRejected({ code: "backup_budget" });
					return {
						backup_bytes: backupBytes,
						backup_limit_bytes: limit,
						removed_backups: removedBackups,
						removed_generations: removedGenerations,
					};
				}),
		};
	});
