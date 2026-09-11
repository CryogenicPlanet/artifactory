import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type StorageVolume =
	| {
			readonly status: "available";
			readonly capacity_bytes: number;
			readonly available_bytes: number;
	  }
	| {
			readonly status: "unavailable";
			readonly reason: "unsupported_platform" | "measurement_failed";
	  };

const unavailable = (): StorageVolume => ({ status: "unavailable", reason: "measurement_failed" });

/** Only fixed, numeric stat output or the C-locale POSIX df format is accepted. */
export const parseStorageVolume = (platform: string, output: string): StorageVolume => {
	if (platform !== "linux" && platform !== "darwin") {
		return { status: "unavailable", reason: "unsupported_platform" };
	}
	if (output.length > 4096) return unavailable();
	const lines = output.trim().split("\n");
	const fields = (platform === "linux" ? lines[0] : lines[1])?.trim().split(/\s+/);
	if (!fields || lines.length !== (platform === "linux" ? 1 : 2)) return unavailable();
	const raw = platform === "linux" ? fields : ["1024", fields[1], fields[3]];
	if (raw.length !== 3) return unavailable();
	if (raw.some((value) => value === undefined || !/^\d+$/.test(value))) return unavailable();
	const [size, blocks, available] = raw.map(Number);
	if (size === undefined || blocks === undefined || available === undefined) return unavailable();
	if (raw.some((value) => !Number.isSafeInteger(Number(value)))) return unavailable();
	const capacity = size * blocks;
	const free = size * available;
	if (size <= 0 || capacity <= 0 || !Number.isSafeInteger(capacity) || !Number.isSafeInteger(free)) {
		return unavailable();
	}
	if (free > capacity) {
		return unavailable();
	}
	return {
		status: "available",
		capacity_bytes: capacity,
		available_bytes: free,
	};
};

/** A sample of caller-available filesystem space, not a reservation or write guarantee. */
export const readStorageVolume = (
	directory: string,
	platform: string = process.platform,
): Effect.Effect<StorageVolume, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (platform !== "linux" && platform !== "darwin") {
			return { status: "unavailable", reason: "unsupported_platform" } satisfies StorageVolume;
		}
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const child = yield* spawner.spawn(
					ChildProcess.make(
						platform === "linux" ? "/usr/bin/stat" : "/bin/df",
						platform === "linux" ? ["-f", "-c", "%S %b %a", "--", directory] : ["-kP", "--", directory],
						{
							env: { LC_ALL: "C" },
							stdin: "ignore",
							stdout: "pipe",
							stderr: "ignore",
							forceKillAfter: "1 second",
						},
					),
				);
				const output = yield* child.stdout.pipe(
					Stream.decodeText(),
					Stream.runFoldEffect(
						() => "",
						(text, chunk) =>
							text.length + chunk.length <= 4096 ? Effect.succeed(text + chunk) : Effect.fail("storage_output_limit"),
					),
				);
				const code = yield* child.exitCode;
				return code === 0 ? parseStorageVolume(platform, output) : unavailable();
			}).pipe(Effect.timeout("2 seconds")),
		).pipe(Effect.orElseSucceed(unavailable));
	});
