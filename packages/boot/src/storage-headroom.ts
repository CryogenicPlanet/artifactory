import { Effect, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readStorageVolume, type StorageVolume } from "./storage-volume.ts";

export class StorageRejected extends Schema.TaggedError<StorageRejected>()("StorageRejected", {
	code: Schema.Literals(["storage_headroom", "storage_measurement_failed"]),
}) {}

/** Admission sample, not a reservation against concurrent processes or arbitrary app growth. */
export const requireHeadroom = (volume: StorageVolume, requiredBytes = 0) => {
	if (
		volume.status !== "available" ||
		!Number.isSafeInteger(requiredBytes) ||
		requiredBytes < 0 ||
		!Number.isSafeInteger(volume.capacity_bytes) ||
		volume.capacity_bytes <= 0 ||
		!Number.isSafeInteger(volume.available_bytes) ||
		volume.available_bytes < 0 ||
		volume.available_bytes > volume.capacity_bytes
	)
		return Effect.fail(new StorageRejected({ code: "storage_measurement_failed" }));
	return volume.available_bytes - requiredBytes < Math.ceil(volume.capacity_bytes / 20)
		? Effect.fail(new StorageRejected({ code: "storage_headroom" }))
		: Effect.void;
};

export const storageHeadroom = (directory: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const sample = readStorageVolume(directory).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
		return {
			sample,
			check: (requiredBytes = 0) => sample.pipe(Effect.flatMap((volume) => requireHeadroom(volume, requiredBytes))),
		};
	});
