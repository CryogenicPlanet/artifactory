import { BunServices } from "@effect/platform-bun";
import { it as effectIt } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";
import { parseStorageVolume, readStorageVolume } from "../src/storage-volume.ts";

describe("storage volume", () => {
	it("converts Linux allocation units and preserves zero available space", () => {
		expect(parseStorageVolume("linux", "4096 100 0 80 20\n")).toEqual({
			status: "available",
			capacity_bytes: 409600,
			available_bytes: 0,
			total_inodes: 80,
			available_inodes: 20,
		});
	});

	it("reads macOS POSIX df blocks without inventing inode counts", () => {
		expect(
			parseStorageVolume(
				"darwin",
				"Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 60 40 60% /Volume with spaces\n",
			),
		).toEqual({
			status: "available",
			capacity_bytes: 102400,
			available_bytes: 40960,
			total_inodes: null,
			available_inodes: null,
		});
	});

	it("rejects malformed, inconsistent, unsafe or oversized measurements", () => {
		for (const output of [
			"",
			"0 100 20 80 20",
			"4096 100 -1 80 20",
			"4096 100 101 80 20",
			"4096 100 20 80 81",
			"4096 9007199254740991 1 80 20",
			"4096 1 0 9007199254740992 1",
			"4096 100 20 80",
			"4096 100 20 80 20 extra",
			"4096 100 20 80 20\nextra",
			"1".repeat(4097),
		]) {
			expect(parseStorageVolume("linux", output)).toEqual({ status: "unavailable", reason: "measurement_failed" });
		}
	});

	it("does not launch commands on unsupported platforms", async () => {
		const spawner = ChildProcessSpawner.make(() => Effect.die("Unexpected command"));
		expect(
			await Effect.runPromise(
				readStorageVolume("/data", "win32").pipe(
					Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
				),
			),
		).toEqual({ status: "unavailable", reason: "unsupported_platform" });
	});

	effectIt.effect("bounds a hung spawn and preserves caller interruption", () =>
		Effect.gen(function* () {
			const spawner = ChildProcessSpawner.make(() => Effect.never);
			const read = readStorageVolume("/data", "linux").pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);
			const timed = yield* read.pipe(Effect.forkChild);
			yield* TestClock.adjust("2 seconds");
			expect(yield* Fiber.join(timed)).toEqual({ status: "unavailable", reason: "measurement_failed" });
			const interrupted = yield* read.pipe(Effect.forkChild);
			yield* Fiber.interrupt(interrupted);
			const exit = yield* Fiber.await(interrupted);
			expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
		}),
	);

	it("cleans up real children on output overflow and timeout", async () => {
		const executablePath = process.env.PATH ?? "";
		await Effect.runPromise(
			Effect.gen(function* () {
				const real = yield* ChildProcessSpawner.ChildProcessSpawner;
				for (const script of ["console.log('x'.repeat(8192)); setInterval(()=>{},1000)", "setInterval(()=>{},1000)"]) {
					const captured = yield* Ref.make<ChildProcessSpawner.ChildProcessHandle | null>(null);
					const spawner = ChildProcessSpawner.make(() =>
						Effect.gen(function* () {
							const child = yield* real.spawn(
								ChildProcess.make("bun", ["-e", script], {
									env: { PATH: executablePath },
									stdin: "ignore",
									stdout: "pipe",
									stderr: "ignore",
									forceKillAfter: "1 second",
								}),
							);
							yield* Ref.set(captured, child);
							return child;
						}),
					);
					expect(
						yield* readStorageVolume("/data", "linux").pipe(
							Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
						),
					).toEqual({ status: "unavailable", reason: "measurement_failed" });
					const child = yield* Ref.get(captured);
					expect(child).not.toBeNull();
					if (child) expect(yield* child.isRunning).toBe(false);
				}
			}).pipe(Effect.provide(BunServices.layer)),
		);
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"measures a real filesystem and treats a missing path as unavailable",
		async () => {
			const run = (path: string) => Effect.runPromise(readStorageVolume(path).pipe(Effect.provide(BunServices.layer)));
			const result = await run(process.cwd());
			expect(result.status).toBe("available");
			if (result.status === "available") {
				expect(result.capacity_bytes).toBeGreaterThan(0);
				expect(result.available_bytes).toBeGreaterThanOrEqual(0);
				expect(result.available_bytes).toBeLessThanOrEqual(result.capacity_bytes);
			}
			expect(await run("/dev/null/comms-missing")).toEqual({
				status: "unavailable",
				reason: "measurement_failed",
			});
		},
	);
});
