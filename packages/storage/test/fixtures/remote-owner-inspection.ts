import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { Context, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { remoteOwnerInspectorLayer, RemoteInspector } from "../../src/remote-inspector.ts";
import { open } from "../../src/remote-driver.ts";
import type { RemoteConnection } from "../../src/remote-session.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const load = async (filename: string): Promise<RemoteConnection> => {
	const value = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
	return { ...value, password: Redacted.make(value.password), tls: false };
};
async function main() {
	const filename = process.env.COMMS_REMOTE_TEST_CONFIG;
	if (!filename) throw Error("Missing test configuration");
	const connection = await load(filename);
	const bootFile = process.env.COMMS_REMOTE_BOOT_TEST_CONFIG;
	const privileged = bootFile ? await load(bootFile) : undefined;
	const mode = process.env.COMMS_REMOTE_TEST_MODE ?? "clean";
	let phase = "initialization";
	const program = Effect.gen(function* () {
		const attempt = "d4".repeat(32);

		const options = {
			connection,
			attempt,
			...(connection.engine === "mysql" && privileged
				? { mysqlBootConnection: mode === "denied" ? connection : privileged }
				: {}),
		};
		if (mode === "denied" || mode === "missing") {
			const layer = remoteOwnerInspectorLayer(mode === "missing" ? { connection, attempt } : options);
			const result = yield* Layer.build(layer).pipe(Effect.exit);
			assert(Exit.isFailure(result));
			assert(!JSON.stringify(result).includes(Redacted.value(connection.password)));
			return;
		}
		phase = "inspector initialization";
		const inspector = Context.get(yield* Layer.build(remoteOwnerInspectorLayer(options)), RemoteInspector);
		phase = "raw connection";
		const child = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(child, exit));
		const raw = yield* Scope.provide(open(connection, "ordinary-untagged-client"), child);
		yield* raw.unsafe("SELECT 1");
		phase = "open account refusal";
		assert(Exit.isFailure(yield* inspector.assertAccountClosed(Effect.fail("local closure absent")).pipe(Effect.exit)));
		assert(
			Exit.isFailure(yield* inspector.assertAccountClosed(Effect.void).pipe(Effect.exit)),
			"Untagged session escaped account inventory",
		);
		if (mode === "xa") {
			assert.equal(connection.engine, "mysql");
			yield* raw.unsafe("CREATE TABLE IF NOT EXISTS remote_owner_probe(value INTEGER) ENGINE=InnoDB");
			yield* Scope.provide(
				Effect.gen(function* () {
					const session = yield* raw.reserve;
					for (const query of [
						"XA START 'comms_owner_probe'",
						"INSERT INTO remote_owner_probe VALUES(1)",
						"XA END 'comms_owner_probe'",
						"XA PREPARE 'comms_owner_probe'",
					])
						yield* session.executeValuesUnprepared(query, []);
				}),
				child,
			);
		}
		phase = "pool shutdown";
		yield* Scope.close(child, Exit.void);
		if (mode === "xa") {
			yield* Effect.sleep("100 millis");
			assert(
				Exit.isFailure(yield* inspector.assertAccountClosed(Effect.void).pipe(Effect.exit)),
				"Prepared XA escaped closure",
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const cleanup = yield* open(connection, "fixture-xa-cleanup");
					const session = yield* cleanup.reserve;
					yield* session.executeValuesUnprepared("XA ROLLBACK 'comms_owner_probe'", []);
				}),
			);
		}
		phase = "final account closure";
		let closed = false;
		for (let index = 0; index < 100; index++) {
			closed = Exit.isSuccess(yield* inspector.assertAccountClosed(Effect.void).pipe(Effect.exit));
			if (closed) break;
			yield* Effect.sleep("50 millis");
		}
		assert(closed, "Account closure never became provable");
	}).pipe(Effect.scoped, Effect.provide(Reactivity.layer));
	try {
		await Effect.runPromise(program);
		process.stdout.write("REMOTE_OWNER_VERIFIED\n");
	} catch {
		throw Error(`Remote owner fixture failed in ${mode} at ${phase}`);
	}
}
await main();
