import { Cause, Clock, Effect, FileSystem, Option, Path, Ref, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { readStorageVolume, type StorageVolume } from "./storage-volume.ts";

const categories = [
	"boot_database",
	"boot_wal",
	"boot_shm",
	"app_database",
	"app_wal",
	"app_shm",
	"generations",
	"backups",
	"prepared_dependencies",
	"prepared_ui",
	"scratch",
] as const;
type Category = (typeof categories)[number];
interface Allocation {
	readonly category: Category;
	readonly bytes: number | null;
	readonly error: "measurement_failed" | "unsupported_metadata" | "different_volume" | "scan_limit" | null;
}
class MeasurementError extends Schema.TaggedError<MeasurementError>()("MeasurementError", {
	code: Schema.Literals(["unsupported_metadata", "different_volume", "scan_limit"]),
}) {}

/** Best-effort allocated blocks, without reading contents or following links outside owned artifact trees. */
export const readStorageAllocation = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.realPath(directory);
		const device = (yield* fs.stat(root)).dev;
		const entries = yield* fs.readDirectory(root);
		if (entries.length > 100_000) return yield* new MeasurementError({ code: "scan_limit" });
		const targets: Readonly<Record<Category, readonly string[]>> = {
			boot_database: ["boot.db"],
			boot_wal: ["boot.db-wal"],
			boot_shm: ["boot.db-shm"],
			app_database: ["comms.db"],
			app_wal: ["comms.db-wal"],
			app_shm: ["comms.db-shm"],
			generations: ["gen"],
			backups: ["backups"],
			prepared_dependencies: ["prepared/dependencies"],
			prepared_ui: ["prepared/ui"],
			scratch: [
				"cache",
				"comms.db.restore",
				...entries.filter((name) =>
					[".backup-drill-", ".proposal-", ".prepare-", ".seed-", ".pages-seed-", ".paths-"].some((prefix) =>
						name.startsWith(prefix),
					),
				),
			],
		};
		const seen = new Set<string>();
		let visited = 0;
		const walk = (file: string): Effect.Effect<number, PlatformError | MeasurementError> =>
			Effect.gen(function* () {
				if (++visited > 100_000) return yield* new MeasurementError({ code: "scan_limit" });
				// realPath also rejects ancestor links; stat alone follows links in Effect's Node/Bun adapter.
				const canonical = yield* fs.realPath(file).pipe(
					Effect.catchIf(
						(error) => error.reason._tag === "NotFound",
						() => Effect.succeed(null),
					),
				);
				if (canonical === null || canonical !== file) return 0;
				const info = yield* fs.stat(file);
				if (info.dev !== device) return yield* new MeasurementError({ code: "different_volume" });
				if (info.type !== "File" && info.type !== "Directory") return 0;
				const inode = Option.getOrNull(info.ino),
					blocks = Option.getOrNull(info.blocks);
				if (
					inode === null ||
					blocks === null ||
					!Number.isSafeInteger(inode) ||
					!Number.isSafeInteger(blocks * 512) ||
					blocks < 0
				)
					return yield* new MeasurementError({ code: "unsupported_metadata" });
				const identity = `${info.dev}:${inode}`;
				if (seen.has(identity)) return 0;
				seen.add(identity);
				let bytes = blocks * 512;
				if (info.type === "Directory") {
					const children = yield* fs.readDirectory(file);
					if (children.length + visited > 100_000) return yield* new MeasurementError({ code: "scan_limit" });
					for (const child of children.sort()) bytes += yield* walk(path.join(file, child));
				}
				if (!Number.isSafeInteger(bytes)) return yield* new MeasurementError({ code: "unsupported_metadata" });
				return bytes;
			});
		const allocated: Allocation[] = [];
		for (const category of categories) {
			const result = yield* Effect.gen(function* () {
				let bytes = 0;
				for (const target of targets[category]) bytes += yield* walk(path.join(root, target));
				if (!Number.isSafeInteger(bytes)) return yield* new MeasurementError({ code: "unsupported_metadata" });
				return bytes;
			}).pipe(Effect.result);
			allocated.push(
				result._tag === "Success"
					? { category, bytes: result.success, error: null }
					: {
							category,
							bytes: null,
							error: Schema.is(MeasurementError)(result.failure) ? result.failure.code : "measurement_failed",
						},
			);
		}
		return allocated;
	});

export interface StorageUsage {
	readonly sampled_at: number | null;
	readonly status: "pending" | "available" | "partial" | "unavailable";
	readonly volume: StorageVolume | null;
	readonly allocated: readonly Allocation[];
	readonly error: "measurement_failed" | null;
}

/** A scoped cache, independent of child/SQL recovery. Requests only read its Ref. */
export const storageUsage = (directory: string) =>
	Effect.gen(function* () {
		const current = yield* Ref.make<StorageUsage>({
			sampled_at: null,
			status: "pending",
			volume: null,
			allocated: [],
			error: null,
		});
		const refresh = Effect.gen(function* () {
			const volume = yield* readStorageVolume(directory);
			const measured = yield* readStorageAllocation(directory).pipe(Effect.timeout("10 seconds"), Effect.result);
			const allocated = measured._tag === "Success" ? measured.success : [];
			yield* Ref.set(current, {
				sampled_at: yield* Clock.currentTimeMillis,
				status:
					measured._tag === "Failure"
						? "unavailable"
						: volume.status === "available" && allocated.every((item) => item.error === null)
							? "available"
							: "partial",
				volume,
				allocated,
				error: measured._tag === "Failure" ? "measurement_failed" : null,
			});
		}).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Ref.set(current, {
							sampled_at: null,
							status: "unavailable",
							volume: null,
							allocated: [],
							error: "measurement_failed",
						}),
			),
		);
		const run = refresh.pipe(Effect.andThen(Effect.sleep("5 minutes")), Effect.forever);
		return { current, refresh, run };
	});
