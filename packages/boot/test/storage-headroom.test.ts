import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Ref, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, type TestContext } from "vitest";
import { Snapshots, layer as snapshotsLayer } from "../src/snapshots.ts";
import { HeadroomPolicy, storageHeadroom, requireHeadroom } from "../src/storage-headroom.ts";

const run = async (test: TestContext, operation: string) => {
	const root = await mkdtemp(join(tmpdir(), "comms-headroom-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/storage-headroom.ts"),
		root,
		operation,
	]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
};

describe("storage headroom admission", () => {
	it("allows exactly five percent, including the requested copy, and refuses one byte less", () => {
		const check = (available: number, required = 0) =>
			Effect.runSync(
				requireHeadroom({ status: "available", capacity_bytes: 1000, available_bytes: available }, required).pipe(
					Effect.result,
				),
			);
		expect(check(50)._tag).toBe("Success");
		expect(check(60, 10)._tag).toBe("Success");
		expect(check(49)).toMatchObject({ _tag: "Failure", failure: { code: "storage_headroom" } });
		expect(check(60, 11)).toMatchObject({ _tag: "Failure", failure: { code: "storage_headroom" } });
	});

	it("fails closed when capacity is unavailable or the requested byte estimate is unsafe", () => {
		for (const reason of ["measurement_failed", "unsupported_platform"] as const)
			expect(Effect.runSync(requireHeadroom({ status: "unavailable", reason }).pipe(Effect.result))).toMatchObject({
				_tag: "Failure",
				failure: { code: "storage_measurement_failed" },
			});
		for (const required of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			expect(
				Effect.runSync(
					requireHeadroom({ status: "available", capacity_bytes: 1000, available_bytes: 1000 }, required).pipe(
						Effect.result,
					),
				),
			).toMatchObject({
				_tag: "Failure",
				failure: { code: "storage_measurement_failed" },
			});
	});

	it("leaves only an unpublished partial snapshot when its next file would consume the reserve", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const real = yield* ChildProcessSpawner.ChildProcessSpawner;
					const root = yield* fs.makeTempDirectoryScoped();
					const sourceDirectory = path.join(root, "app");
					const generationsDirectory = path.join(root, "gen");
					yield* fs.makeDirectory(sourceDirectory);
					yield* fs.makeDirectory(generationsDirectory);
					yield* fs.writeFileString(path.join(sourceDirectory, "a.ts"), "a".repeat(1024));
					yield* fs.writeFileString(path.join(sourceDirectory, "b.ts"), "b".repeat(1024));
					const output =
						process.platform === "linux"
							? "1024 100 6\n"
							: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 100 94 6 94% /data\n";
					const spawner = ChildProcessSpawner.make(() =>
						real.spawn(
							ChildProcess.make("/usr/bin/printf", ["%s", output], {
								stdout: "pipe",
								stderr: "ignore",
								stdin: "ignore",
							}),
						),
					);
					const snapshots = yield* Snapshots.pipe(
						Effect.provide(snapshotsLayer({ sourceDirectory, generationsDirectory })),
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					);
					expect(yield* snapshots.create(1).pipe(Effect.result)).toMatchObject({
						_tag: "Failure",
						failure: { code: "storage_headroom" },
					});
					expect(yield* fs.exists(path.join(generationsDirectory, "1/source"))).toBe(false);
					expect(yield* fs.readFileString(path.join(generationsDirectory, "1/.partial/a.ts"))).toBe("a".repeat(1024));
					expect(yield* fs.exists(path.join(generationsDirectory, "1/.partial/b.ts"))).toBe(false);
					expect(yield* fs.readFileString(path.join(sourceDirectory, "a.ts"))).toBe("a".repeat(1024));
					expect(yield* fs.readFileString(path.join(sourceDirectory, "b.ts"))).toBe("b".repeat(1024));
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	});

	it("refuses a backup before creating its destination but still permits recovery restore", async (test) => {
		expect(await run(test, "backup")).toMatchObject({
			estimatedBytes: expect.any(Number),
			refusal: { _tag: "Failure", failure: { code: "storage_headroom" } },
			destinationExists: false,
			restored: [{ value: "before backup" }],
		});
	});

	it("refuses source growth without changing staging or history, while deletion and pending recovery remain available", async (test) => {
		expect(await run(test, "source")).toMatchObject({
			stage: { _tag: "Failure", failure: { code: "storage_headroom" } },
			page: { _tag: "Failure", failure: { code: "storage_headroom" } },
			staging: [],
			history: [],
			beforeDeletion: "original",
			deleted: true,
			interrupted: { _tag: "Failure", failure: { _tag: "SqlError" } },
			recovered: expect.any(String),
			recoveredAgain: null,
			recoveredContent: "recovered page",
			pending: [],
		});
	});
});

it("captures a scoped policy effect and reads its latest percentage for each admission", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const percent = yield* Ref.make(5);
			const headroom = yield* storageHeadroom("/tmp").pipe(Effect.provideService(HeadroomPolicy, Ref.get(percent)));
			const volume = { status: "available", capacity_bytes: 1000, available_bytes: 100 } as const;
			expect((yield* headroom.reserve(volume).pipe(Effect.result))._tag).toBe("Success");
			yield* Ref.set(percent, 15);
			expect(yield* headroom.reserve(volume).pipe(Effect.result)).toMatchObject({
				failure: { code: "storage_headroom" },
			});
			yield* Ref.set(percent, 4);
			expect(yield* headroom.reserve(volume).pipe(Effect.result)).toMatchObject({
				failure: { code: "storage_measurement_failed" },
			});
		}).pipe(Effect.provide(BunServices.layer)),
	);
});
