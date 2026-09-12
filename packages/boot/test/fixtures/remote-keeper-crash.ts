import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { render } from "@comms/storage/store";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { launchChild } from "../../src/child-process.ts";
import { ChildConfiguration } from "../../src/keeper-configuration.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";
import { configuration } from "./remote-keeper-config.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.GUARDIAN_TEST_ROOT ?? process.argv[2] ?? "");
	const mode = process.env.GUARDIAN_TEST_MODE ?? process.argv[3] ?? "active";
	const config = yield* configuration;
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const interrupted = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { GUARDIAN_TEST_ROOT: root, GUARDIAN_TEST_MODE: mode },
			}),
		).pipe(Effect.exit);
		console.log(`ROOT_LAUNCH_RESULT=${interrupted._tag}`);
		if (interrupted._tag === "Failure")
			console.log(
				`ROOT_FAILURE_CODES=${
					JSON.stringify(interrupted)
						.match(/remote_[a-z_]+|[A-Za-z]+Error|Remote boot [A-Za-z ]+/g)
						?.join(",") ?? "none"
				}`,
			);
		assert.equal(interrupted._tag, "Failure", "Boot worker should have been killed");
		const recovered = yield* Effect.scoped(remoteOwnerInventory(root)).pipe(Effect.exit);
		console.log(`ROOT_INVENTORY_RESULT=${recovered._tag}`);
		if (recovered._tag === "Failure")
			console.log(
				`ROOT_RECOVERY_CODES=${
					JSON.stringify(recovered)
						.match(/remote_[a-z_]+|[A-Za-z]+Error/g)
						?.join(",") ?? "none"
				}`,
			);
		assert.equal(recovered._tag, "Success");
		console.log("ROOT_KEEPER_CLOSURE_VERIFIED");
		return;
	}
	const runtime = yield* remoteRuntime(config, root);
	assert.equal((yield* runtime.bootSql<{ value: number }>`SELECT 1 AS value`)[0]?.value, 1);
	const attempt = "e8".repeat(32);
	const selected = {
		entry: fileURLToPath(new URL("./remote-keeper-child.ts", import.meta.url)),
		cwd: root,
		env: { APP_STORE: Redacted.value(render(config.app)), MODE: "root-crash" },
		receipt: `${root}/closed`,
		attempt,
		remote: yield* runtime.reserveOwner(config.app, attempt),
	};
	const child = yield* launchChild(selected);
	if (mode === "delayed") {
		const delayedAttempt = "e9".repeat(32);
		const delayed = {
			...selected,
			attempt: delayedAttempt,
			receipt: `${root}/delayed-closed`,
			remote: yield* runtime.reserveOwner(config.app, delayedAttempt),
		};
		yield* fs.writeFileString(
			`${root}/delayed-config.json`,
			yield* Schema.encodeEffect(Schema.fromJsonString(ChildConfiguration))(delayed),
			{ mode: 0o600 },
		);
	}
	yield* fs.writeFileString(
		`${root}/ready.json`,
		JSON.stringify({ worker: process.pid, child: child.pid, root: runtime.rootAttempt }),
		{ mode: 0o600 },
	);
	return yield* Effect.never;
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause(() => Effect.die("Remote keeper crash acceptance failed")),
	BunRuntime.runMain,
);
