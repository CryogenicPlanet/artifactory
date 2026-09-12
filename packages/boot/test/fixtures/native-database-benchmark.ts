// Opt-in measurements against disposable databases. Never used by runtime startup.
/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, effecttsgo/global-fetch, effecttsgo/prefer-schema-over-json */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Effect, Redacted, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { dumpRemote, loadRemote } from "@comms/storage/remote-copy";
import type { RemoteStore } from "@comms/storage/store";

const Connection = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const open = (config: typeof Connection.Type) => {
	const options = { ...config, password: Redacted.make(config.password) };
	return config.engine === "pg" ? PgClient.make(options) : MysqlClient.make(options);
};
const load = async (file: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(await readFile(file, "utf8"));
const integer = (raw: string | undefined, fallback: number, max: number) => {
	const value = raw === undefined ? fallback : Number(raw);
	assert(Number.isSafeInteger(value) && value > 0 && value <= max, "Invalid benchmark size");
	return value;
};
const version = async (command: string, argument = "--version") =>
	(await promisify(execFile)(command, [argument])).stdout.trim();
const report = async (file: string, value: unknown) =>
	writeFile(resolve(file), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });

async function copy(args: string[]) {
	const [sourceFile, targetFile, output, rowsRaw, bytesRaw] = args;
	assert(sourceFile && targetFile && output, "copy SOURCE_CONFIG TARGET_CONFIG REPORT [ROWS] [BODY_BYTES]");
	const source = await load(sourceFile),
		target = await load(targetFile);
	assert.equal(source.engine, target.engine);
	assert.equal(source.host, target.host);
	assert.equal(source.port, target.port);
	assert.notEqual(source.database, target.database);
	for (const config of [source, target]) {
		assert(["127.0.0.1", "localhost"].includes(config.host), "Loopback test server required");
		assert(/^comms_benchmark_[a-z0-9_]+$/.test(config.database), "Dedicated benchmark database required");
	}
	const rows = integer(rowsRaw, 10_000, 1_000_000),
		bodyBytes = integer(bytesRaw, 1024, 65535);
	assert(rows * bodyBytes <= 1_073_741_824, "Benchmark payload exceeds 1 GiB");
	const root = await mkdtemp(join(tmpdir(), "comms-benchmark-"));
	const descriptor = (config: typeof Connection.Type): RemoteStore => ({
		_tag: config.engine === "pg" ? "postgres" : "mysql",
		database: config.database,
		url: Redacted.make(
			`${config.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`,
		),
	});
	const body = (id: number) => {
		// Deterministic varied ASCII payload avoids unrealistically compressible repeated padding.
		let value = "";
		for (let block = 0; value.length < bodyBytes; block++)
			value += createHash("sha256").update(`${id}:${block}`).digest("hex");
		return value.slice(0, bodyBytes);
	};
	const result = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* open(source);
				const destination = yield* open(target);
				const empty =
					source.engine === "pg"
						? "SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'"
						: "SELECT CAST(COUNT(*) AS CHAR) AS n FROM information_schema.tables WHERE table_schema=DATABASE()";
				for (const client of [sql, destination]) {
					const count = yield* client
						.unsafe(empty)
						.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.String })))));
					assert.equal(count[0]?.n, "0", "Refusing nonempty benchmark database");
				}
				const server = yield* sql
					.unsafe("SELECT version() AS version")
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ version: Schema.String })))));
				yield* sql.unsafe("CREATE TABLE benchmark_messages(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
				const seedStarted = performance.now();
				for (let start = 0; start < rows; start += 100) {
					const batch = Array.from({ length: Math.min(100, rows - start) }, (_, i) => ({
						id: start + i,
						body: body(start + i),
					}));
					yield* sql`INSERT INTO benchmark_messages ${sql.insert(batch)}`;
				}
				const seedMs = performance.now() - seedStarted;
				const sizes =
					source.engine === "pg"
						? "SELECT pg_database_size(current_database())::text AS bytes"
						: "SELECT CAST(COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) AS CHAR) AS bytes FROM information_schema.tables WHERE table_schema=DATABASE()";
				const size = (client: typeof sql) =>
					client.unsafe(sizes).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ bytes: Schema.String })))),
						Effect.map((items) => Number(items[0]?.bytes ?? "0")),
					);
				if (source.engine === "mysql") yield* sql.unsafe("ANALYZE TABLE benchmark_messages");
				const sourceBytes = yield* size(sql);
				const dumpStarted = performance.now();
				const artifact = yield* dumpRemote({
					store: descriptor(source),
					path: join(root, "backup"),
					tls: false,
					budget: "10 minutes",
				});
				const dumpMs = performance.now() - dumpStarted,
					loadStarted = performance.now();
				yield* loadRemote({ store: descriptor(target), artifact, tls: false, budget: "10 minutes" });
				const loadMs = performance.now() - loadStarted;
				const Record = Schema.Array(Schema.Struct({ id: Schema.Int, body: Schema.String }));
				for (let start = 0; start < rows; start += 100) {
					const records =
						yield* destination`SELECT id,body FROM benchmark_messages WHERE id>=${start} AND id<${Math.min(start + 100, rows)} ORDER BY id`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Record)),
						);
					assert.equal(records.length, Math.min(100, rows - start));
					for (const record of records) assert.equal(record.body, body(record.id), "Copied payload mismatch");
				}
				if (source.engine === "mysql") yield* destination.unsafe("ANALYZE TABLE benchmark_messages");
				return {
					engine: source.engine,
					server: server[0]?.version,
					rows,
					body_bytes: bodyBytes,
					payload_bytes: rows * bodyBytes,
					seed_ms: seedMs,
					dump_ms: dumpMs,
					load_ms: loadMs,
					copy_ms: dumpMs + loadMs,
					artifact_bytes: artifact.bytes,
					source_database_bytes: sourceBytes,
					target_database_bytes: yield* size(destination),
					verified: true,
				};
			}),
		).pipe(Effect.provide(Reactivity.layer), Effect.provide(BunServices.layer)),
	);
	await report(output, {
		...result,
		host: `${platform()}/${arch()}`,
		runtime: await version("bun", "--revision"),
		node_compatibility_version: process.version,
		dump_client: await version(source.engine === "pg" ? "pg_dump" : "mysqldump"),
		load_client: await version(source.engine === "pg" ? "pg_restore" : "mysql"),
		mode: "Native dump/load primitive; synthetic message-shaped table, not full board or logical engine transfer",
		capacity_note:
			"PostgreSQL includes catalog/database overhead; MySQL information_schema allocation is approximate and may lag",
		artifacts_directory: root,
		transfer_downtime_ms: null,
	});
}

async function traffic(args: string[]) {
	const [origin, stateFile, output, countRaw] = args;
	assert(origin && stateFile && output, "traffic LOOPBACK_ORIGIN PRIVATE_STATE REPORT [POSTS_PER_WRITER]");
	const url = new URL(origin);
	assert(
		url.protocol === "http:" && url.hostname === "localhost" && url.port,
		"Explicit disposable localhost board required",
	);
	const { cookie } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ cookie: Schema.String })))(
		await readFile(stateFile, "utf8"),
	);
	const count = integer(countRaw, 100, 10_000),
		topic = `benchmark/run-${Date.now()}`;
	const request = (path: string, body: unknown) =>
		fetch(new URL(path, url), {
			method: "POST",
			headers: { cookie, origin, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(180_000),
			redirect: "error",
		});
	const Message = Schema.Struct({ id: Schema.String, seq: Schema.Int, body: Schema.String });
	const accepted: Array<typeof Message.Type> = [],
		latencies: number[] = [],
		refusals: number[] = [];
	const refusalDetails: Record<string, number> = {};
	console.log("Benchmark traffic: acquire edit lock");
	assert.equal((await request("/_boot/lock", {})).status, 200, "Edit lock required");
	// A unique valid extension ensures reload performs a real candidate cutover.
	const path = `/_boot/fs/app/ext/benchmark-${Date.now()}.ts?baseVersion=null&reload=0`;
	console.log("Benchmark traffic: stage extension");
	const staged = await fetch(new URL(path, url), {
		method: "PUT",
		headers: { cookie, origin },
		body: "export default function () {}\n",
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(staged.status, 200, "Stage benchmark extension");
	const sent = [0, 0, 0, 0];
	let began = 0,
		reloading = true;
	const deadline = performance.now() + 180_000;
	const writes = Array.from({ length: 4 }, (_, writer) =>
		(async () => {
			for (let i = 0; (i < count || reloading) && performance.now() < deadline; i++) {
				began++;
				sent[writer] = i + 1;
				const started = performance.now(),
					response = await request("/api/messages", { topic, body: `${writer}:${i}` });
				latencies.push(performance.now() - started);
				if (response.status === 200) accepted.push(Schema.decodeUnknownSync(Message)(await response.json()));
				else {
					refusals.push(response.status);
					const refusal = Schema.decodeUnknownOption(
						Schema.Struct({ error: Schema.Struct({ code: Schema.String, retriable: Schema.Boolean }) }),
					)(await response.json().catch(() => null));
					const code =
						refusal._tag === "Some" && /^[a-z_]{1,64}$/.test(refusal.value.error.code)
							? refusal.value.error.code
							: "unclassified";
					const retriable = refusal._tag === "Some" ? String(refusal.value.error.retriable) : "unknown";
					const key = `${response.status}:${code}:retriable=${retriable}`;
					refusalDetails[key] = (refusalDetails[key] ?? 0) + 1;
				}
			}
		})(),
	);
	const completed = Promise.allSettled(writes);
	assert.equal(began, 4);
	let swap: unknown;
	try {
		console.log("Benchmark traffic: reload with four writers");
		const response = await request("/_boot/reload", {});
		console.log(`Benchmark traffic: reload HTTP ${response.status}`);
		assert.equal(response.status, 200);
		swap = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.Literal("live"), freeze_ms: Schema.Finite }))(
			await response.json(),
		);
	} finally {
		reloading = false;
		const outcomes = await completed;
		assert(
			outcomes.every((outcome) => outcome.status === "fulfilled"),
			"Writer request failed",
		);
	}
	console.log(`Benchmark traffic: verify ${accepted.length} acknowledged messages`);
	for (const message of accepted) {
		const response = await fetch(
			new URL(`/api/messages?since=${message.seq - 1}&wait=0&limit=1&mark=0&topic=${encodeURIComponent(topic)}`, url),
			{
				headers: { cookie },
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (response.status !== 200) console.log(`Benchmark traffic: readback HTTP ${response.status}`);
		assert.equal(response.status, 200, "Acknowledged write missing after reload");
		const page = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Message) }))(await response.json());
		if (
			page.items.length !== 1 ||
			page.items[0]?.id !== message.id ||
			page.items[0]?.seq !== message.seq ||
			page.items[0]?.body !== message.body
		)
			console.log(`Benchmark traffic: readback mismatch (rows=${page.items.length})`);
		assert.deepEqual(page.items, [message]);
	}
	latencies.sort((a, b) => a - b);
	await report(output, {
		mode: "Four HTTP writer loops during actual reload; dedicated board only",
		writer_count: 4,
		minimum_posts_per_writer: count,
		sent_per_writer: sent,
		minimum_met: sent.every((value) => value >= count),
		acknowledged: accepted.length,
		refusals,
		refusal_details: refusalDetails,
		swap,
		latency_ms: {
			p50: latencies[Math.floor(latencies.length * 0.5)],
			p95: latencies[Math.floor(latencies.length * 0.95)],
			max: latencies.at(-1),
		},
		verified: true,
		limitation:
			"Concurrency requested at HTTP boundary, not proof of four simultaneously held database locks. Extension and benchmark messages retained.",
	});
	assert(
		sent.every((value) => value >= count),
		"Writer deadline reached before minimum count",
	);
}
const [mode, ...args] = process.argv.slice(2);
try {
	assert(
		process.env.COMMS_DISPOSABLE_BENCHMARK === "1",
		"Set COMMS_DISPOSABLE_BENCHMARK=1 only for dedicated test resources",
	);
	if (mode === "copy") await copy(args);
	else if (mode === "traffic") await traffic(args);
	else throw new Error("Expected copy or traffic mode");
} catch {
	console.error("Benchmark failed; private resources retained, no credential-bearing error printed.");
	process.exitCode = 1;
}
