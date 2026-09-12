import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Fiber, FileSystem, Ref, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildError, launchChild } from "../../src/child-process.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || (mode !== "running" && mode !== "failure")) return yield* Effect.die("Invalid fixture arguments");
	const fs = yield* FileSystem.FileSystem;
	const password = "split/private@password?fixture";
	const descriptor = `postgres://fixture:${encodeURIComponent(password)}@localhost/app`;
	const entry = `${root}/child.ts`;
	// Separate writes with acknowledgements and delays so the keeper receives partial lines.
	yield* fs.writeFileString(
		entry,
		`
const password = ${JSON.stringify(password)};
const descriptor = process.env.APP_STORE;
if (!descriptor) throw new Error("Missing fixture store");
const write = (text: string) => new Promise<void>((resolve) => process.stderr.write(text, () => resolve()));
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
${mode === "running" ? 'console.log("COMMS_CHILD_PORT=12345");' : ""}
for (const value of [descriptor, password, encodeURIComponent(password)]) {
  const split = Math.floor(value.length / 2);
  await write("SQLSTATE=08006 " + value.slice(0, split)); await pause();
  await write(value.slice(split) + " request=fixture\\n"); await pause();
}
await write("x".repeat(65530)); await pause();
await write("oversized-tail-canary " + password + "\\n"); await pause();
await write("EOF diagnostic " + password.slice(0, 8)); await pause();
await write(password.slice(8)); await pause();
process.exit(0);
`,
	);
	const result = yield* launchChild({
		entry,
		cwd: root,
		env: { APP_STORE: descriptor },
		receipt: `${root}/closed`,
		attempt: "fixture-attempt",
	}).pipe(Effect.result);
	if (result._tag === "Failure") {
		if (mode !== "failure" || !Schema.is(ChildError)(result.failure)) return yield* result.failure;
		yield* Console.log(
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
				code: result.failure.code,
				stderr: result.failure.stderr,
			}),
		);
		return;
	}
	if (mode !== "running") return yield* Effect.die("Expected startup refusal");
	const child = result.success;
	const observed = yield* Ref.make<readonly string[]>([]);
	const sampling = yield* Effect.forever(
		Ref.get(child.stderr).pipe(
			Effect.flatMap((text) => Ref.update(observed, (all) => [...all, text])),
			Effect.andThen(Effect.sleep("5 millis")),
		),
	).pipe(Effect.forkScoped);
	yield* child.exited;
	yield* child.stop;
	yield* Fiber.interrupt(sampling);
	yield* Console.log(
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
			stderr: yield* Ref.get(child.stderr),
			observed: yield* Ref.get(observed),
		}),
	);
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
