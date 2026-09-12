import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";
import { ChildError } from "../src/child-process.ts";
import { PreparationProcess, layer } from "../src/preparation-process.ts";

describe("preparation deadlines", () => {
	for (const operation of ["install", "build"] as const) {
		it.effect(`bounds stderr and interrupts a real hung ${operation} subprocess at its deadline`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const root = yield* fs.makeTempDirectoryScoped();
					const marker = path.join(root, "ready");
					const real = yield* ChildProcessSpawner.ChildProcessSpawner;
					// The keeper's ordinary descendant cleanup is exercised separately. Replace
					// only its entry here to make the runner's two production deadlines measurable.
					const spawner = ChildProcessSpawner.make(() =>
						real.spawn(
							ChildProcess.make(
								"bun",
								[
									"-e",
									`import {writeFileSync} from 'node:fs'; console.error('x'.repeat(20000)); writeFileSync(process.argv[1],'ready'); setInterval(()=>{},1000)`,
									marker,
								],
								{
									env: { PATH: process.env.PATH ?? "" },
									stdin: "pipe",
									stdout: "ignore",
									stderr: "pipe",
									forceKillAfter: "2 seconds",
								},
							),
						),
					);
					const commands = yield* PreparationProcess.pipe(
						Effect.provide(layer),
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					);
					const done = yield* Ref.make(false);
					const running = yield* (
						operation === "install" ? commands.install(root) : commands.build(root, path.join(root, "board"))
					).pipe(
						Effect.result,
						Effect.tap(() => Ref.set(done, true)),
						Effect.forkChild,
					);
					yield* TestClock.withLive(
						Effect.gen(function* () {
							while (!(yield* fs.exists(marker))) yield* Effect.sleep("10 millis");
							yield* Effect.sleep("20 millis");
						}),
					);
					yield* TestClock.adjust(operation === "install" ? "59 seconds" : "119 seconds");
					expect(yield* Ref.get(done)).toBe(false);
					yield* TestClock.adjust("1 second");
					const result = yield* Fiber.join(running);
					expect(result).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "ChildError", code: `preparation_${operation}_timeout` },
					});
					if (result._tag === "Failure" && Schema.is(ChildError)(result.failure)) {
						expect(result.failure.code).toBe(`preparation_${operation}_timeout`);
						expect(result.failure.stderr?.length).toBe(8192);
					}
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	}
});
