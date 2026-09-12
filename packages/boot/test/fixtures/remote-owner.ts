import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { remoteOwner, recoverRemoteOwners } from "../../src/remote-owner.ts";

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(process.argv[2] ?? "");
	const mode = process.argv[3];
	const attempt = "a1".repeat(32);
	const selected = {
		attempt,
		root: "b2".repeat(32),
		scope: mode === "account" || mode === "recover-account" ? ("account" as const) : ("database" as const),
		engine: "pg" as const,
		host: "localhost",
		port: 5432,
		tls: false,
		database: "app",
		username: "app",
	};
	const tag = Buffer.from(attempt, "hex").toString("base64url");
	const session = {
		engine: "pg" as const,
		server: "server-observation",
		database: "app",
		username: "app",
		connectionId: "10",
		tag: `inspect:${tag}`,
	};
	const file = path.join(root, "remote-owners", `${attempt}.json`);
	if (mode === "recover" || mode === "recover-account") return yield* recoverRemoteOwners(root, [selected]);
	const owner = yield* remoteOwner(root, selected);
	const pause = Console.log("REMOTE_OWNER_DURABLE").pipe(Effect.andThen(Effect.never));
	if (mode === "crash-intent") return yield* pause;
	assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	yield* owner.bindInspector(session);
	if (mode === "pending") return;
	if (mode === "account")
		yield* owner.register({ ...session, database: "scratch", connectionId: "99", tag: `comms:${tag}` });
	else
		assert.equal(
			(yield* owner
				.register({ ...session, database: "scratch", connectionId: "99", tag: `comms:${tag}` })
				.pipe(Effect.result))._tag,
			"Failure",
		);
	yield* Effect.all(
		Array.from({ length: 8 }, (_, index) =>
			owner.register({ ...session, connectionId: String(index + 20), tag: `comms:${tag}` }),
		),
		{ concurrency: 8 },
	);
	const before = yield* fs.readFileString(file);
	const registered = yield* Schema.decodeEffect(
		Schema.fromJsonString(Schema.Struct({ sessions: Schema.Array(Schema.Unknown) })),
	)(before);
	assert.equal(registered.sessions.length, mode === "account" ? 9 : 8);
	if (mode === "crash-register") return yield* pause;
	assert.equal((yield* owner.close(Effect.fail("local closure missing")).pipe(Effect.result))._tag, "Failure");
	assert.equal(yield* fs.readFileString(file), before);
	assert.equal(
		(yield* owner.register({ ...session, connectionId: "88", tag: `comms:${tag}` }).pipe(Effect.result))._tag,
		"Failure",
	);
	yield* owner.close(Effect.void);
	yield* owner.close(Effect.die("Closed receipt must not rerun proof"));
	yield* recoverRemoteOwners(root, [selected]);
	assert.equal((yield* recoverRemoteOwners(root, []).pipe(Effect.result))._tag, "Failure");
	assert.equal(
		(yield* recoverRemoteOwners(root, [{ ...selected, root: "c3".repeat(32) }]).pipe(Effect.result))._tag,
		"Failure",
	);
	if (mode === "mismatch") {
		yield* fs.writeFileString(file, (yield* fs.readFileString(file)).replace('"database":"app"', '"database":"other"'));
		assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	}
	if (mode === "partial") {
		yield* fs.writeFileString(file, "{");
		assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	}
	if (mode === "bad-inspector" || mode === "bad-session") {
		const before = yield* fs.readFileString(file);
		yield* fs.writeFileString(
			file,
			before.replace(mode === "bad-inspector" ? '"tag":"inspect:' : '"tag":"comms:', '"tag":"wrong:'),
		);
		assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	}
	if (mode === "missing") {
		yield* fs.remove(file);
		assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	}
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
