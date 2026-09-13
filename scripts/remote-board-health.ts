// HTTP-only failure acceptance against the same disposable board used by remote-board-http.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch */
import assert from "node:assert/strict";
import { Schema } from "effect";

const Status = Schema.Struct({
	last_good: Schema.Int,
	child: Schema.Struct({ state: Schema.String, generation: Schema.Int }),
	store_identity: Schema.Struct({ app_store_id: Schema.String, selected_database: Schema.String }),
});
const Message = Schema.Struct({ id: Schema.String, seq: Schema.Int, topic: Schema.String, body: Schema.String });
export const failedHealth = async (address: URL, origin: string, cookie: string, retainedTopic: string) => {
	const request = async (path: string, method = "GET", body?: string) => {
		const response = await fetch(new URL(path, address), {
			method,
			headers: { cookie, origin, "content-type": "application/json" },
			...(body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(180000),
		});
		assert.equal(response.status, 200, `Failed-health acceptance ${path.split("?")[0]}: HTTP ${response.status}`);
		return response;
	};
	const status = async () => Schema.decodeUnknownSync(Status)(await (await request("/_boot/status")).json());
	const prior = await status();
	assert.equal(prior.child.state, "live");
	const sourceRead = await request("/api/fs/app/server.ts");
	const baseVersion = sourceRead.headers.get("x-chirp-base-version");
	assert.ok(baseVersion);
	const source = await sourceRead.text();
	const anchor = 'if (request.url === "/health" && request.method === "GET") return yield* health;';
	assert.equal(source.split(anchor).length, 2, "Selected source must expose the exact health boundary");
	const marker = `native-candidate-health-${crypto.randomUUID()}.json`;
	const changed = source.replace("type FileSystem,", "FileSystem,").replace(
		anchor,
		`if (request.url === "/health" && request.method === "GET" && lifecycle.initial === "candidate") {
const sql = Context.get(sqlContext, SqlClient);
const before = yield* sql\`SELECT id FROM messages WHERE topic = \${${JSON.stringify(retainedTopic)}}\`;
yield* sql\`DELETE FROM messages WHERE topic = \${${JSON.stringify(retainedTopic)}}\`;
const after = yield* sql\`SELECT id FROM messages WHERE topic = \${${JSON.stringify(retainedTopic)}}\`;
const fs = yield* FileSystem.FileSystem;
const receiptDirectory = yield* Config.String("TMPDIR");
yield* Effect.scoped(Effect.gen(function* () { const receipt = yield* fs.open(receiptDirectory + "/" + ${JSON.stringify(marker)}, {flag:"wx",mode:0o600}); yield* receipt.writeAll(new TextEncoder().encode(JSON.stringify({marker:${JSON.stringify(marker)},before:before.length,after:after.length}))); yield* receipt.sync; }));
return HttpServerResponse.jsonUnsafe({status:"failed"},{status:503,headers:{"x-chirp-health-ready":"1"}});
} ${anchor}`,
	);
	await request("/api/lock", "POST", JSON.stringify({ note: "native candidate health failure acceptance" }));
	const sourceResponse = await fetch(
		new URL(`/api/fs/app/server.ts?reload=0&baseVersion=${encodeURIComponent(baseVersion)}`, address),
		{
			method: "PUT",
			headers: { cookie, origin },
			body: changed,
			signal: AbortSignal.timeout(180000),
		},
	);
	assert.equal(sourceResponse.status, 200, "Stage candidate-only health failure");
	const reload = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String, generation: Schema.Int }))(
		await (await request("/api/reload?release=1", "POST", "{}")).json(),
	);
	assert.equal(reload.status, "failed");
	const after = await status();
	assert.equal(after.child.state, "live");
	assert.equal(after.last_good, prior.last_good);
	assert.equal(after.child.generation, prior.child.generation);
	assert.equal(after.store_identity.app_store_id, prior.store_identity.app_store_id);
	assert.notEqual(
		after.store_identity.selected_database,
		prior.store_identity.selected_database,
		"Failed candidate must restore into a new selected native database",
	);
	const generations = Schema.decodeUnknownSync(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					n: Schema.Int,
					status: Schema.String,
					backup_id: Schema.NullOr(Schema.String),
					snapshot_dir: Schema.NullOr(Schema.String),
					stderr: Schema.NullOr(Schema.String),
				}),
			),
		}),
	)(await (await request("/_boot/generations")).json());
	const failed = generations.items.find((row) => row.n === reload.generation);
	assert.ok(failed && failed.status === "failed" && failed.backup_id && failed.snapshot_dir);
	assert.ok(
		failed.n > 0 && failed.snapshot_dir.endsWith(`/gen/${failed.n}/source`),
		"Expected frozen generation layout",
	);

	const backups = Schema.decodeUnknownSync(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					reason: Schema.String,
					engine: Schema.String,
				}),
			),
		}),
	)(await (await request("/_boot/db/backups")).json());
	const backup = backups.items.find((row) => row.id === failed.backup_id);
	assert.ok(backup && backup.reason === "pre-flip" && ["pg", "mysql"].includes(backup.engine));
	const topic = `${retainedTopic}/after-health-failure`;
	const written = Schema.decodeUnknownSync(Message)(
		await (
			await request(
				"/api/messages",
				"POST",
				JSON.stringify({ topic, body: "Fresh write after rejected native candidate" }),
			)
		).json(),
	);
	assert.equal(written.topic, topic);
	return {
		marker,
		markerPath: `/data/runtime/${marker}`,
		written,
		priorGeneration: prior.last_good,
		storeId: after.store_identity.app_store_id,
		selectedDatabase: after.store_identity.selected_database,
		failedGeneration: reload.generation,
		backup: backup.id,
	};
};

export const verifyHealthMarker = (expected: string, text: string) => {
	const receipt = Schema.decodeSync(
		Schema.fromJsonString(Schema.Struct({ marker: Schema.String, before: Schema.Int, after: Schema.Int })),
	)(text);
	assert.equal(receipt.marker, expected);
	assert.ok(receipt.before > 0, "Candidate health must alter actual acknowledged data");
	assert.equal(receipt.after, 0);
};
