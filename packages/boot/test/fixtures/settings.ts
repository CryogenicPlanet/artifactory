import { Auth, layer as authLayer } from "../../src/auth.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { authentication } from "../../src/auth-http.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { SettingsChange, validPublicPath } from "../../src/settings-schema.ts";
import { settingsRoute } from "../../src/settings-http.ts";
import { sessionCookie } from "../../src/auth-http.ts";
import { fails, tokenSession } from "./token-session.ts";
const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	if (scenario === "resume") {
		const saved = yield* Schema.decodeEffect(
			Schema.fromJsonString(Schema.Struct({ params: SettingsChange, proof: authentication, session: Schema.String })),
		)(yield* fs.readFileString(`${filename}.retry`));
		const context = yield* Layer.build(
			authLayer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Layer.provideMerge(lockLayer.pipe(Layer.provideMerge(eventsLayer(Effect.void)))),
			),
		);
		const restarted = Context.get(context, Auth);
		const first = yield* restarted.changeSettings(saved.params, saved.proof, saved.session);
		assert.equal(first.revision, 1);
		assert.equal((yield* restarted.settings).revision, 2);
		return;
	}
	const { auth, sql, device } = yield* tokenSession;
	const login = yield* auth.startLogin;
	let counter = 2;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, counter));
	const params: SettingsChange = {
		revision: 0,
		patch: {
			event_retention: { http_request_days: 2, other_days: 40 },
			storage: { backup_percent: 15, event_percent: 12, headroom_percent: 8 },
			public_paths: ["/welcome"],
		},
	};
	const proofFor = (input = params, owner = session.id, origin?: string) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startSettingsAssertion(input, owner);
			return { id: challenge.id, response: device.assertion(challenge.options.challenge, ++counter, origin) };
		});
	if (scenario === "persist") {
		const proof = yield* proofFor();
		yield* auth.changeSettings(params, proof, session.id);
		const next = { revision: 1, patch: { public_paths: ["/later"] } };
		yield* auth.changeSettings(next, yield* proofFor(next), session.id);
		yield* fs.writeFileString(`${filename}.retry`, JSON.stringify({ params, proof, session: session.id }), {
			mode: 0o600,
		});
	} else if (scenario === "binding") {
		let proof = yield* proofFor();
		yield* fails(auth.changeSettings({ ...params, revision: 1 }, proof, session.id), "challenge_invalid");
		yield* fails(auth.changeSettings(params, proof, "other"), "session_invalid");
		yield* fails(
			auth.changeSettings(params, yield* proofFor(params, session.id, "https://evil.test"), session.id),
			"authentication_invalid",
		);
		const secondLogin = yield* auth.startLogin;
		const second = yield* auth.finishLogin(secondLogin.id, device.assertion(secondLogin.options.challenge, ++counter));
		const rebound = yield* proofFor();
		yield* fails(auth.changeSettings(params, rebound, second.id), "challenge_invalid");
		const restart = yield* auth.startRestartAssertion(session.id);
		yield* fails(
			auth.changeSettings(
				params,
				{ id: restart.id, response: device.assertion(restart.options.challenge, ++counter) },
				session.id,
			),
			"challenge_invalid",
		);
		proof = yield* proofFor();
		const accepted = yield* auth.changeSettings(params, proof, session.id);
		assert.equal(accepted.revision, 1);
		const next = { revision: 1, patch: { public_paths: ["/new"] } };
		yield* auth.changeSettings(next, yield* proofFor(next), session.id);
		assert.deepEqual(yield* auth.changeSettings(params, proof, session.id), accepted);
		assert.deepEqual((yield* auth.settings).public_paths, ["/new"]);
		assert.equal((yield* sql`SELECT * FROM events WHERE type='settings.changed'`).length, 2);
		yield* fails(
			auth.changeSettings({ ...params, patch: { public_paths: [] } }, proof, session.id),
			"settings_conflict",
		);
		yield* auth.logout(session.token);
		yield* fails(auth.changeSettings(params, proof, session.id), "session_invalid");
	} else if (scenario === "transaction") {
		const proof = yield* proofFor();
		yield* sql`CREATE TRIGGER fail_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'settings.receipt:%' BEGIN SELECT RAISE(ABORT,'disk failed'); END`;
		yield* fails(auth.changeSettings(params, proof, session.id));
		assert.equal((yield* auth.settings).revision, 0);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		assert.equal((yield* sql`SELECT * FROM events WHERE type='settings.changed'`).length, 0);
		yield* sql`DROP TRIGGER fail_receipt`;
		const results = yield* Effect.all(
			[auth.changeSettings(params, proof, session.id), auth.changeSettings(params, proof, session.id)],
			{ concurrency: "unbounded" },
		);
		assert.deepEqual(results[0], results[1]);
		assert.equal((yield* sql`SELECT * FROM events WHERE type='settings.changed'`).length, 1);
	} else if (scenario === "http") {
		const route = (method: string, headers: Record<string, string>, data?: unknown) =>
			settingsRoute(auth, { rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(
						new Request("https://comms.test/_boot/settings", {
							method,
							headers,
							...(data === undefined ? {} : { body: JSON.stringify(data) }),
						}),
					),
				),
			);
		const cookie = `${sessionCookie}=${session.token}`;
		assert.equal((yield* route("GET", {}))?.status, 401);
		assert.equal((yield* route("GET", { cookie, authorization: "Bearer bad" }))?.status, 401);
		assert.equal((yield* route("GET", { cookie }))?.status, 200);
		assert.equal((yield* route("POST", { cookie, origin: "https://evil.test" }, params))?.status, 403);
		assert.equal(
			(yield* route("POST", { cookie, origin: "https://comms.test" }, { revision: 0, patch: { internal: "x" } }))
				?.status,
			400,
		);
		const proof = yield* proofFor();
		assert.equal(
			(yield* route(
				"POST",
				{
					cookie,
					origin: "https://comms.test",
					"x-comms-assertion": Buffer.from(JSON.stringify(proof)).toString("base64url"),
				},
				params,
			))?.status,
			200,
		);
	} else if (scenario === "late-session") {
		const proof = yield* proofFor();
		const ready = Promise.withResolvers<void>();
		let send = () => {};
		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					send = () => {
						controller.enqueue(new TextEncoder().encode(JSON.stringify(params)));
						controller.close();
					};
				},
				pull() {
					ready.resolve();
				},
			},
			{ highWaterMark: 0 },
		);
		const request = new Request("https://comms.test/_boot/settings", {
			method: "POST",
			headers: {
				cookie: `${sessionCookie}=${session.token}`,
				origin: "https://comms.test",
				"x-comms-assertion": Buffer.from(JSON.stringify(proof)).toString("base64url"),
			},
			body: stream,
		});
		const pending = yield* settingsRoute(auth, { rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
			Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
			Effect.forkScoped,
		);
		yield* Effect.promise(() => ready.promise);
		yield* auth.logout(session.token);
		send();
		assert.equal((yield* Fiber.join(pending))?.status, 401);
		assert.equal((yield* auth.settings).revision, 0);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 1);
	} else if (scenario === "schema") {
		for (const path of [
			"/_boot/status",
			"/_kernel/health",
			"/api/fs/app/x",
			"/api/lock",
			"/api/events",
			"/auth/login",
			"/approve/x",
			"/setup",
			"/p/private",
			"/%5fboot/status",
			"//host",
			"/a/../_boot",
			"/a?b",
			"/a#b",
			"/a\\b",
		])
			assert.equal(validPublicPath(path), false, path);
		for (const storage of [
			{ backup_percent: 20, event_percent: 10, headroom_percent: 4 },
			{ backup_percent: 80, event_percent: 15, headroom_percent: 5 },
			{ backup_percent: 0, event_percent: 10, headroom_percent: 5 },
		])
			assert.equal(Schema.is(SettingsChange)({ revision: 0, patch: { storage } }), false);
		yield* fails(
			Schema.decodeUnknownEffect(SettingsChange)({ revision: 0, patch: { public_paths: ["/welcome", "/welcome"] } }),
		);
		assert.equal((yield* auth.settings).storage.headroom_percent, 5);
	} else throw new Error("Unknown scenario");
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
console.log("settings passed");
