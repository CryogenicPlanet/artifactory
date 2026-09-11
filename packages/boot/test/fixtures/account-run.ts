/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Crypto, Effect, Layer, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { accountRoute } from "../../src/account-http.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { layer as editLockLayer } from "../../src/edit-lock.ts";

const filename = process.argv[2];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const context = yield* Layer.build(
		layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
			Layer.provide(Layer.mergeAll(eventsLayer, editLockLayer)),
		),
	);
	const auth = Context.get(context, Auth);
	const store = yield* Ref.make<Auth["Service"] | null>(auth);
	const now = yield* Clock.currentTimeMillis;
	const enrollmentId = (letter: string) => `e_${letter.repeat(43)}`;
	const familyId = (letter: string) => `f_${letter.repeat(43)}`;
	const token = "s".repeat(43);
	const crypto = yield* Crypto.Crypto;
	const hash = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
	yield* sql`INSERT INTO sessions (id,hash,created_at,expires_at) VALUES('human',${hash},${now},${now + 100000})`;
	const cookie = `__Host-comms_session=${token}`;
	const request = (path: string, headers: Readonly<Record<string, string>> = { cookie }) =>
		accountRoute(store).pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(new Request(`https://comms.test${path}`, { headers })),
			),
			Effect.map((response) => {
				assert.ok(response);
				return HttpServerResponse.toWeb(response);
			}),
		);
	if (process.argv[3] === "enrollments") {
		for (const [letter, status, expires] of [
			["z", "pending", 0],
			["y", "approved", 0],
			["x", "pending", now + 10000],
			["w", "pending", now + 10000],
			["v", "denied", 0],
			["u", "collected", 0],
		] satisfies ReadonlyArray<readonly [string, string, number]>) {
			yield* sql`INSERT INTO enrollments(id,device_secret_hash,user_code,agent_name,kind,host,status,family,created_at,expires_at,scopes)
			VALUES(${enrollmentId(letter)},${`secret-${letter}`},'ABCD12','codex','codex','laptop',${status},${familyId(letter)},${now},${expires},${status === "pending" ? null : '["read"]'})`;
		}
		const first = yield* auth.listEnrollments({ limit: 1, before: null, status: "pending" });
		assert.equal(first.items[0]?.id, enrollmentId("x"));
		assert.equal(first.next, enrollmentId("x"));
		const second = yield* auth.listEnrollments({ limit: 1, before: first.next, status: "pending" });
		assert.equal(second.items[0]?.id, enrollmentId("w"));
		assert.equal(second.next, null);
		assert.equal(first.items[0]?.family, null);
		assert.equal(first.items[0]?.scopes, null);
		const expired = yield* auth.listEnrollments({ limit: 100, before: null, status: "expired" });
		assert.deepEqual(
			expired.items.map((row) => row.id),
			[enrollmentId("z"), enrollmentId("y")],
		);
		assert.equal((yield* auth.listEnrollments({ limit: 100, before: null, status: "denied" })).items.length, 1);
		assert.equal((yield* auth.listEnrollments({ limit: 100, before: null, status: "collected" })).items.length, 1);
		const response = yield* request("/_boot/enrollments?status=pending&limit=1");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const payload = yield* Effect.promise(() => response.text());
		assert.ok(!payload.includes("secret"));
		assert.deepEqual(
			Object.keys(first.items[0] ?? {}).sort(),
			["id", "name", "kind", "host", "user_code", "status", "created_at", "expires_at", "scopes", "family"].sort(),
		);
	} else if (process.argv[3] === "families") {
		for (const letter of ["z", "y", "x"]) {
			for (const generation of [1, 2])
				for (const kind of ["access", "refresh"]) {
					const id = `${letter}-${generation}-${kind}`;
					yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at,last_used_at,revoked_at)
				VALUES(${id},${`${letter}-${generation}`},${familyId(letter)},'codex',${kind},${`secret-${id}`},'machine','["read","write"]',${generation * 100 + (kind === "refresh" ? 1000 : 0)},${generation},${generation === 2 ? 25 : null},${letter === "y" ? 40 : null})`;
				}
		}
		assert.equal((yield* sql`SELECT id FROM enrollments`).length, 0);
		const first = yield* auth.listTokenFamilies({ limit: 1, before: null });
		assert.deepEqual(first.items, [
			{
				family: familyId("z"),
				agent: "codex",
				label: "machine",
				scopes: ["read", "write"],
				created_at: 1,
				last_used_at: 25,
				access_expires_at: 200,
				refresh_expires_at: 1200,
				revoked: false,
			},
		]);
		yield* sql`UPDATE tokens SET last_used_at=2000 WHERE family=${familyId("x")}`;
		const second = yield* auth.listTokenFamilies({ limit: 1, before: first.next });
		assert.equal(second.items[0]?.family, familyId("y"));
		assert.equal(second.items[0]?.revoked, true);
		const third = yield* auth.listTokenFamilies({ limit: 1, before: second.next });
		assert.equal(third.items[0]?.family, familyId("x"));
		assert.equal(third.next, null);
		const response = yield* request("/_boot/tokens");
		assert.equal(response.status, 200);
		assert.ok(!(yield* Effect.promise(() => response.text())).includes("secret"));
	} else {
		for (const path of ["/_boot/enrollments", "/_boot/tokens"]) {
			for (const headers of [
				{},
				{ "x-comms-auth-kind": "human", "x-comms-agent": "rahul" },
				{ authorization: `Bearer ${"a".repeat(43)}` },
				{ cookie, authorization: `Bearer ${"a".repeat(43)}` },
				{ cookie: `${cookie}; ${cookie}` },
			])
				assert.equal((yield* request(path, headers)).status, 401);
			assert.equal((yield* request(path)).status, 200);
			for (const query of [
				"?limit=0",
				"?limit=201",
				"?limit=1&limit=2",
				"?limit=1.0",
				"?limit=1e2",
				"?before=",
				"?unknown=1",
			])
				assert.equal((yield* request(path + query)).status, 400);
		}
		for (const query of ["?status=unknown", "?status=pending&status=pending"])
			assert.equal((yield* request("/_boot/enrollments" + query)).status, 400);
		assert.equal((yield* request("/_boot/tokens?status=pending")).status, 400);
		yield* sql`UPDATE sessions SET expires_at=0 WHERE id='human'`;
		assert.equal((yield* request("/_boot/tokens")).status, 401);
		yield* Ref.set(store, null);
		assert.equal((yield* request("/_boot/tokens")).status, 503);
	}
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("account scenario passed"));
