import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { remoteRootAdmission } from "../../src/remote-root-admission.ts";
import { remoteOwner, recoverRemoteOwners } from "../../src/remote-owner.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.realPath(process.argv[2] ?? "");
	const mode = process.argv[3];
	const root = "a2".repeat(32);
	const intent = {
		root,
		attempt: "b3".repeat(32),
		scope: "database" as const,
		engine: "pg" as const,
		host: "127.0.0.1",
		port: 5432,
		tls: false,
		database: "app",
		username: "app",
	};
	const admission = yield* remoteRootAdmission(directory, root);
	yield* admission.reserve(intent);
	if (mode === "admitted") yield* admission.admit(intent.attempt);
	const owner = yield* remoteOwner(directory, intent);
	assert.equal((yield* owner.neverOpened.pipe(Effect.result))._tag, "Failure");
	yield* admission.close;
	assert.equal((yield* admission.admit(intent.attempt).pipe(Effect.result))._tag, "Failure");
	assert.equal((yield* owner.neverOpened.pipe(Effect.result))._tag, "Failure");
	assert.equal((yield* admission.workerClosed(Effect.fail("no local closure")).pipe(Effect.result))._tag, "Failure");
	assert.equal((yield* owner.neverOpened.pipe(Effect.result))._tag, "Failure");
	yield* admission.workerClosed(Effect.void);
	if (mode === "admitted") {
		assert.equal((yield* owner.neverOpened.pipe(Effect.result))._tag, "Failure");
		assert.equal((yield* recoverRemoteOwners(directory, [intent]).pipe(Effect.result))._tag, "Failure");
		return;
	}
	yield* owner.neverOpened;
	yield* recoverRemoteOwners(directory, [intent]);
	if (mode === "missing-proof") yield* fs.remove(`${directory}/remote-admission-${root}.json`);
	if (mode === "changed-proof") {
		const name = `${directory}/remote-admission-${root}.json`;
		yield* fs.writeFileString(name, (yield* fs.readFileString(name)).replace('"admitted":false', '"admitted":true'));
	}
	if (mode !== "clean")
		assert.equal((yield* recoverRemoteOwners(directory, [intent]).pipe(Effect.result))._tag, "Failure");
});
program.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
