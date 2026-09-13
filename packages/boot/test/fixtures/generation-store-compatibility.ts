import { BunRuntime, BunServices } from "@effect/platform-bun";
import type { Store } from "@comms/storage/store";
import { Effect, FileSystem, Layer, Path, Redacted, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "bun:test";
import { snapshotStoreEntry } from "../../src/application.ts";
import { AppRecovery } from "../../src/app-recovery.ts";
import { ChildAttempts } from "../../src/child-attempts.ts";
import { ChildError } from "../../src/child-process.ts";
import { ChildConfiguration } from "../../src/keeper-configuration.ts";
import { NetAddress } from "effect/unstable/net";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";
import { Generations, type Generation } from "../../src/generations.ts";
import { supervise } from "../../src/supervisor.ts";

const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
	const source = path.join(root, "gen/1/source");
	yield* fs.makeDirectory(source, { recursive: true });
	yield* fs.writeFileString(path.join(source, "server.ts"), "// immutable fixture source");
	const generation: Generation = {
		n: 1,
		snapshot_dir: source,
		entry_file: "server.ts",
		backup_id: null,
		status: "retired",
		good: 1,
		stderr: "",
		error: null,
		started_at: 0,
		healthy_at: 1,
		retired_at: 2,
	};
	const file: Store = { _tag: "file", filename: path.join(root, "app.db") };
	const pg: Store = { _tag: "postgres", database: "app", url: Redacted.make("postgres://app:secret@localhost/app") };
	const mysql: Store = { _tag: "mysql", database: "app", url: Redacted.make("mysql://app:secret@localhost/app") };
	const manifest = path.join(source, "package.json");
	return { fs, root, source, generation, file, pg, mysql, manifest };
});
const services = Layer.mergeAll(
	FetchHttpClient.layer,
	BunServices.layer,
	Layer.succeed(
		HttpServer.HttpServer,
		HttpServer.make({
			serve: () => Effect.die("Unexpected HTTP listener"),
			address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 12345),
		}),
	),
);

const case1 = Effect.scoped(
	Effect.gen(function* () {
		const f = yield* fixture;
		expect(yield* snapshotStoreEntry(f.generation, f.root, f.file)).toBe(`${f.source}/server.ts`);
		for (const store of [f.pg, f.mysql])
			expect(yield* snapshotStoreEntry(f.generation, f.root, store).pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { code: "generation_store_incompatible" },
			});
		yield* f.fs.makeDirectory(`${f.root}/app`);
		yield* f.fs.writeFileString(`${f.root}/app/package.json`, '{"comms":{"storage_engines":["pg","mysql"]}}');
		expect(yield* snapshotStoreEntry(f.generation, f.root, f.pg).pipe(Effect.result)).toMatchObject({
			_tag: "Failure",
		});
		for (const manifest of ["{}", '{"comms":{}}']) {
			yield* f.fs.writeFileString(f.manifest, manifest);
			expect(yield* snapshotStoreEntry(f.generation, f.root, f.file)).toBe(`${f.source}/server.ts`);
			expect(yield* snapshotStoreEntry(f.generation, f.root, f.pg).pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
			});
		}
	}),
).pipe(Effect.provide(services));

const case2 = Effect.scoped(
	Effect.gen(function* () {
		const f = yield* fixture;
		for (const manifest of [
			"false",
			"{",
			'{"comms":false}',
			'{"comms":{"storage_engines":false}}',
			'{"comms":{"storage_engines":["pg","oracle"]}}',
			'{"comms":{"storage_engines":[]}}',
			'{"comms":{"storage_engines":["sqlite"]}}',
		]) {
			yield* f.fs.writeFileString(f.manifest, manifest);
			expect(yield* snapshotStoreEntry(f.generation, f.root, f.pg).pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { code: "generation_store_incompatible" },
			});
		}
		yield* f.fs.remove(f.manifest);
		yield* f.fs.writeFileString(`${f.root}/external.json`, '{"comms":{"storage_engines":["pg"]}}');
		yield* f.fs.symlink(`${f.root}/external.json`, f.manifest);
		expect(yield* snapshotStoreEntry(f.generation, f.root, f.pg).pipe(Effect.result)).toMatchObject({
			_tag: "Failure",
		});
		yield* f.fs.remove(`${f.root}/external.json`);
		expect(yield* snapshotStoreEntry(f.generation, f.root, f.file).pipe(Effect.result)).toMatchObject({
			_tag: "Failure",
		});
	}),
).pipe(Effect.provide(services));

const case3 = Effect.scoped(
	Effect.gen(function* () {
		const f = yield* fixture;
		const text = '{"comms":{"storage_engines":["sqlite","pg","mysql"]}}';
		yield* f.fs.writeFileString(f.manifest, text);
		for (const store of [f.pg, f.mysql, f.pg, f.file])
			expect(yield* snapshotStoreEntry(f.generation, f.root, store)).toBe(`${f.source}/server.ts`);
		expect(yield* f.fs.readFileString(f.manifest)).toBe(text);
	}),
).pipe(Effect.provide(services));

const case4 = Effect.scoped(
	Effect.gen(function* () {
		const f = yield* fixture;
		const reserved = yield* Ref.make(0);
		const prepared = yield* Ref.make(0);
		const launched = yield* Ref.make<Readonly<Record<string, string>> | null>(null);
		const owners = ChildAttempts.of({
			reserve: () =>
				Ref.update(reserved, (n) => n + 1).pipe(Effect.as({ id: "a".repeat(64), receipt: `${f.root}/receipt` })),
			opened: () => Effect.void,
			closed: () => Effect.succeed(true),
			recover: Effect.succeed(undefined),
		});
		const recovery = AppRecovery.of({
			checkSchema: Effect.succeed(undefined),
			store: Effect.succeed(f.pg),
			filename: undefined,
			dataDirectory: f.root,
			prepare: () => Ref.update(prepared, (n) => n + 1).pipe(Effect.as(undefined)),
			reserveIdentity: Effect.die("unexpected identity reservation"),
			identityStatus: Effect.die("unexpected identity status"),
			selectRestored: () => Effect.die("unexpected store selection"),
		});
		const spawner = ChildProcessSpawner.make((command) =>
			Effect.gen(function* () {
				if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected piped command");
				const configuration = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChildConfiguration))(
					command.options.env?.COMMS_CHILD_CONFIG,
				).pipe(Effect.orDie);
				yield* Ref.set(launched, configuration.env);
				return yield* Effect.die("captured launch before process creation");
			}),
		);
		const unused = Effect.die("Unexpected generation transition");
		const generations = Generations.of({
			list: unused,
			recover: unused,
			appSeeded: unused,
			markAppSeeded: unused,
			reserve: () => unused,
			setSnapshot: () => unused,
			starting: () => unused,
			retired: () => unused,
			rehearsed: () => unused,
			healthy: () => unused,
			failed: () => unused,
		});
		const supervisor = yield* supervise({ dataDirectory: f.root, seedDirectory: f.source, entryFile: "server.ts" });
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(
				yield* supervisor
					.start(f.generation)
					.pipe(
						Effect.provideService(AppRecovery, recovery),
						Effect.provideService(Generations, generations),
						Effect.provideService(ChildAttempts, owners),
						Effect.result,
					),
			).toMatchObject({ _tag: "Failure", failure: { code: "generation_store_incompatible" } });
			expect(
				yield* supervisor
					.launch(f.generation, f.mysql, "rehearsal")
					.pipe(Effect.provideService(ChildAttempts, owners), Effect.result),
			).toMatchObject({ _tag: "Failure", failure: { code: "generation_store_incompatible" } });
		}
		expect(yield* Ref.get(prepared)).toBe(0);
		expect(yield* Ref.get(reserved)).toBe(0);
		yield* supervisor
			.launch(f.generation, f.file, "candidate")
			.pipe(
				Effect.provideService(ChildAttempts, owners),
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
				Effect.exit,
			);
		expect(yield* Ref.get(reserved)).toBe(1);
		expect(yield* Ref.get(launched)).toMatchObject({
			APP_DATABASE: f.file._tag === "file" ? f.file.filename : "",
			APP_STORE: expect.stringContaining("file:"),
		});
		expect(new ChildError({ code: "generation_store_incompatible" }).message).not.toContain("secret");
	}),
).pipe(Effect.provide(services));

const selected = process.argv[2];
const main =
	selected === "1"
		? case1
		: selected === "2"
			? case2
			: selected === "3"
				? case3
				: selected === "4"
					? case4
					: Effect.die("Missing compatibility case");
main.pipe(BunRuntime.runMain);
