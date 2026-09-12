import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { render } from "@comms/storage/store";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";
import { configuration } from "./remote-keeper-config.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.argv[2] ?? "");
	const mode = process.argv[3] ?? "eof";
	const config = yield* configuration;
	const attempt = "e7".repeat(32);
	yield* Effect.scoped(
		Effect.gen(function* () {
			const runtime = yield* remoteRuntime(config, root);
			const remote = yield* runtime.reserveOwner(config.app, attempt);
			const receipt = join(root, "closed");
			let childPid: number | undefined;
			let verified = false;
			const child = yield* Effect.acquireRelease(
				Effect.sync(() =>
					spawn("bun", [join(import.meta.dirname, "../../src/child-keeper.ts")], {
						cwd: root,
						env: {
							PATH: process.env.PATH,
							COMMS_CHILD_CONFIG: JSON.stringify({
								entry: join(import.meta.dirname, "remote-keeper-child.ts"),
								cwd: root,
								env: { APP_STORE: Redacted.value(render(config.app)), MODE: mode },
								receipt,
								attempt,
								remote,
							}),
						},
						stdio: ["pipe", "pipe", "pipe"],
					}),
				),
				(child) =>
					Effect.promise(async () => {
						if (!verified && childPid !== undefined) {
							try {
								process.kill(-childPid, "SIGKILL");
							} catch (error) {
								if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
							}
						}
						if (child.exitCode === null && child.signalCode === null) {
							const exited = once(child, "exit");
							child.kill("SIGKILL");
							await exited;
						}
						if (!verified && childPid !== undefined) {
							let absent = false;
							for (let n = 0; n < 100; n++) {
								try {
									process.kill(-childPid, 0);
								} catch (error) {
									if (error instanceof Error && "code" in error && error.code === "ESRCH") {
										absent = true;
										break;
									}
									throw error;
								}
								await delay(20);
							}
							assert(absent, "Fixture cleanup left editable group alive");
						}
					}),
			);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				const pid = Number(output.match(/COMMS_CHILD_PID=(\d+)/)?.[1]);
				if (Number.isSafeInteger(pid) && pid > 1) childPid = pid;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const exited = once(child, "close");
			const ready = mode === "reject" ? "REGISTRATION_REJECTED" : "REMOTE_CHILD_READY";
			for (let n = 0; n < 150 && !output.includes(ready); n++) {
				if (child.exitCode !== null || child.signalCode !== null) break;
				yield* Effect.sleep("50 millis");
			}
			assert(output.includes(ready), "Keeper child did not reach SQL/registration assertion");
			assert(!output.includes(Redacted.value(config.bootConnection.password)), "Boot credential appeared in output");
			if (mode === "eof") child.stdin.end();
			if (mode === "kill") {
				const pid = Number(output.match(/COMMS_CHILD_PID=(\d+)/)?.[1]);
				assert(Number.isSafeInteger(pid) && pid > 1);
				process.kill(pid, "SIGKILL");
			}
			yield* Effect.promise(() => exited).pipe(Effect.timeout("10 seconds"));
			assert.equal(child.exitCode, 0, "Keeper did not prove closure");
			assert(
				!output.includes(Redacted.value(config.bootConnection.password)),
				"Boot credential appeared during shutdown",
			);
			assert.equal(yield* fs.readFileString(receipt), attempt);
			assert.equal((yield* fs.stat(receipt)).mode & 0o777, 0o600);
			const owner = yield* fs
				.readFileString(join(root, "remote-owners", `${attempt}.json`))
				.pipe(
					Effect.flatMap(
						Schema.decodeEffect(
							Schema.fromJsonString(Schema.Struct({ state: Schema.String, sessions: Schema.Array(Schema.Unknown) })),
						),
					),
				);
			assert.equal(owner.state, "closed");
			assert.equal(owner.sessions.length > 0, mode !== "reject");
			const sessions =
				config.appConnection.engine === "pg"
					? yield* runtime.bootSql`SELECT pid FROM pg_stat_activity WHERE usename = ${config.appConnection.username}`
					: yield* runtime.bootSql`SELECT PROCESSLIST_ID FROM performance_schema.threads WHERE PROCESSLIST_USER = ${config.appConnection.username} AND TYPE = 'FOREGROUND'`;
			assert.equal(sessions.length, 0, "App account remains active after durable keeper receipt");
			if (mode === "reject") {
				const tables = yield* runtime.withStore(
					config.app,
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'remote_keeper_registration_must_not_run'`;
					}),
				);
				assert.equal(tables.length, 0, "Rejected registration still executed SQL");
			}
			verified = true;
		}),
	);
	yield* Effect.scoped(remoteOwnerInventory(root));
	console.log("REMOTE_KEEPER_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(
	Effect.catchCause(() => Effect.die("Remote keeper acceptance failed")),
	BunRuntime.runMain,
);
