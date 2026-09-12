import { strict as assert } from "node:assert";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { connectionOf, parseDescriptor } from "@comms/storage/store";
import { BunHttpServer } from "@effect/platform-bun";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

const program = Effect.gen(function* () {
	for (const name of [
		"COMMS_CHILD_CONFIG",
		"COMMS_REMOTE_ROOT_CONFIG",
		"BOOT_DATABASE_URL",
		"COMMS_REMOTE_BOOT_TEST_CONFIG",
		"COMMS_REMOTE_TEST_CONFIG",
	])
		assert.equal(process.env[name], undefined, `Private keeper environment leaked: ${name}`);
	const store = yield* parseDescriptor(process.env.APP_STORE ?? "");
	if (store._tag === "file") throw new Error("Expected remote child store");
	const connection = yield* connectionOf(store, false);
	const attempt = process.env.REMOTE_ATTEMPT ?? "";
	let rejectedStatusObserved = false;
	const layer = guardianClientLayer({
		connection,
		attempt,
		register: (session) =>
			Effect.tryPromise(async () => {
				const response = await fetch(`${process.env.REMOTE_GUARDIAN_URL}/register`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-comms-guardian-secret":
							process.env.MODE === "reject" ? "incorrect" : (process.env.REMOTE_GUARDIAN_SECRET ?? ""),
					},
					body: JSON.stringify(session),
				});
				assert.equal(response.status, process.env.MODE === "reject" ? 403 : 204);
				if (response.status === 403) rejectedStatusObserved = true;
				if (response.status !== 204) throw new Error("Registration rejected");
			}),
	});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		if (process.env.MODE === "reject") {
			const rejected = yield* sql
				.unsafe("CREATE TABLE remote_keeper_registration_must_not_run (value INTEGER)")
				.pipe(Effect.result);
			assert.equal(rejected._tag, "Failure");
			assert(rejectedStatusObserved, "Failure did not come from rejected HTTP registration");
			console.log("REGISTRATION_REJECTED");
			return;
		}
		const identity = yield* sql.unsafe<{ name: string }>(
			connection.engine === "pg" ? "SELECT current_user AS name" : "SELECT CURRENT_USER() AS name",
		);
		assert(identity[0]?.name === connection.username || identity[0]?.name.startsWith(`${connection.username}@`));
		if (process.env.MODE === "root-crash") {
			process.on("SIGTERM", () => {});
			const server = Context.get(
				yield* Layer.build(
					HttpRouter.serve(HttpRouter.add("GET", "/", Effect.succeed(HttpServerResponse.empty()))).pipe(
						Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
					),
				),
				HttpServer.HttpServer,
			);
			assert(server.address._tag !== "UnixPathAddress");
			console.log(`COMMS_CHILD_PORT=${server.address.port}`);
		}
		console.log("REMOTE_CHILD_READY");
		return yield* Effect.never;
	}).pipe(Effect.provide(layer));
}).pipe(Effect.scoped);
await Effect.runPromise(program).catch(() => {
	throw new Error("Remote child acceptance failed");
});
