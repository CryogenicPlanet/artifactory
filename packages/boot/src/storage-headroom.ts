import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { readStoragePolicy } from "./settings-schema.ts";
import { readStorageVolume, type StorageVolume } from "./storage-volume.ts";

export class StorageRejected extends Schema.TaggedError<StorageRejected>()("StorageRejected", {
	code: Schema.Literals(["storage_headroom", "storage_measurement_failed"]),
}) {}

/** Standalone filesystem tools retain the minimum reserve. Boot supplies its persisted policy. */
export const HeadroomPolicy = Context.Reference<Effect.Effect<number, StorageRejected>>("comms/boot/HeadroomPolicy", {
	defaultValue: () => Effect.succeed(5),
});

export const headroomPolicyLayer = Layer.effect(
	HeadroomPolicy,
	SqlClient.SqlClient.pipe(
		Effect.map((sql) =>
			readStoragePolicy.pipe(
				Effect.map((policy) => policy.headroom_percent),
				Effect.mapError(() => new StorageRejected({ code: "storage_measurement_failed" })),
				Effect.provideService(SqlClient.SqlClient, sql),
			),
		),
	),
);

/** Admission sample, not a reservation against concurrent processes or arbitrary app growth. */
export const requireHeadroom = (volume: StorageVolume, requiredBytes = 0, percent = 5) => {
	if (
		volume.status !== "available" ||
		!Number.isFinite(percent) ||
		percent < 5 ||
		percent >= 100 ||
		!Number.isSafeInteger(requiredBytes) ||
		requiredBytes < 0 ||
		!Number.isSafeInteger(volume.capacity_bytes) ||
		volume.capacity_bytes <= 0 ||
		!Number.isSafeInteger(volume.available_bytes) ||
		volume.available_bytes < 0 ||
		volume.available_bytes > volume.capacity_bytes
	)
		return Effect.fail(new StorageRejected({ code: "storage_measurement_failed" }));
	return volume.available_bytes - requiredBytes < Math.ceil(volume.capacity_bytes * (percent / 100))
		? Effect.fail(new StorageRejected({ code: "storage_headroom" }))
		: Effect.void;
};

export const storageHeadroom = (directory: string) =>
	Effect.gen(function* () {
		const policy = yield* HeadroomPolicy;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const sample = readStorageVolume(directory).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
		const reserve = (volume: StorageVolume, requiredBytes = 0) =>
			policy.pipe(Effect.flatMap((percent) => requireHeadroom(volume, requiredBytes, percent)));
		return {
			sample,
			reserve,
			check: (requiredBytes = 0) => sample.pipe(Effect.flatMap((volume) => reserve(volume, requiredBytes))),
		};
	});
