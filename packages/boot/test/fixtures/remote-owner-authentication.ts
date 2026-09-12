import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { RemoteAuthenticationRejected, type RemoteSession } from "@comms/storage/remote-session";
import { Effect, FileSystem, Path } from "effect";
import { remoteOwner, recoverRemoteOwners, type RemoteOwnerIntent } from "../../src/remote-owner.ts";

Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(process.argv[2] ?? "");
	const engine: "pg" | "mysql" = process.argv[3] === "pg" ? "pg" : "mysql";
	const selected: RemoteOwnerIntent = {
		attempt: "a1".repeat(32),
		root: "b2".repeat(32),
		scope: "database" as const,
		engine,
		host: "localhost",
		port: engine === "pg" ? 5432 : 3306,
		tls: false,
		database: "app",
		username: "app",
	};
	const rejected = new RemoteAuthenticationRejected({ engine, code: engine === "pg" ? "28P01" : "1045" });
	const owner = yield* remoteOwner(root, selected);
	const file = path.join(root, "remote-owners", `${selected.attempt}.json`);
	const pending = yield* fs.readFileString(file);
	// Wrong engine/code and a pending network failure cannot become positive closure.
	assert.equal(
		(yield* owner
			.authenticationRejected(new RemoteAuthenticationRejected({ engine, code: engine === "pg" ? "1045" : "28P01" }))
			.pipe(Effect.result))._tag,
		"Failure",
	);
	assert.equal(
		(yield* owner
			.authenticationRejected(
				new RemoteAuthenticationRejected({
					engine: engine === "pg" ? "mysql" : "pg",
					code: rejected.code,
				}),
			)
			.pipe(Effect.result))._tag,
		"Failure",
	);
	assert.equal(yield* fs.readFileString(file), pending);
	assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	yield* owner.authenticationRejected(rejected);
	yield* recoverRemoteOwners(root, [selected]);
	const receipt = yield* fs.readFileString(file);
	assert.equal(receipt.includes('"state":"authentication-rejected"'), true);
	assert.equal((yield* owner.authenticationRejected(rejected).pipe(Effect.result))._tag, "Failure");
	const session: RemoteSession = {
		engine,
		server: "server",
		database: "app",
		username: engine === "pg" ? "app" : "app@%",
		connectionId: "10",
		tag: `inspect:${Buffer.from(selected.attempt, "hex").toString("base64url")}`,
	};
	assert.equal((yield* owner.bindInspector(session).pipe(Effect.result))._tag, "Failure");
	for (const forged of [
		receipt.replace(`"authentication":"${rejected.code}"`, '"authentication":"ambiguous"'),
		receipt.replace(`,"authentication":"${rejected.code}"`, ""),
		receipt.replace('"inspector":null', `"inspector":${JSON.stringify(session)}`),
		receipt.replace('"sessions":[]', `"sessions":[${JSON.stringify(session)}]`),
		receipt.replace('"state":"authentication-rejected"', '"state":"pending"'),
	]) {
		yield* fs.writeFileString(file, forged);
		assert.equal((yield* recoverRemoteOwners(root, [selected]).pipe(Effect.result))._tag, "Failure");
	}
	yield* fs.writeFileString(file, receipt);
	const lateRoot = path.join(root, "late");
	yield* fs.makeDirectory(lateRoot);
	const late = yield* remoteOwner(lateRoot, selected);
	yield* late.bindInspector(session);
	assert.equal((yield* late.authenticationRejected(rejected).pipe(Effect.result))._tag, "Failure");
	assert.equal((yield* recoverRemoteOwners(lateRoot, [selected]).pipe(Effect.result))._tag, "Failure");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
