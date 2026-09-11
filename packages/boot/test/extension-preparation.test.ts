import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import { ChildError } from "../src/child-process.ts";
import { GenerationPreparation, layer } from "../src/generation-preparation.ts";
import { PreparationProcess } from "../src/preparation-process.ts";
import { copySource } from "../src/snapshots.ts";

const platform = Layer.mergeAll(BunServices.layer, BunCrypto.layer, BunFileSystem.layer, Path.layer);
const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
	const source = path.join(root, "app");
	yield* fs.makeDirectory(source);
	const installs = yield* Ref.make<ReadonlyArray<string>>([]);
	const writePackage = (relative: string, content: string, lock = content) =>
		Effect.gen(function* () {
			const directory = path.join(source, relative);
			yield* fs.makeDirectory(directory, { recursive: true });
			yield* fs.writeFileString(
				path.join(directory, "package.json"),
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ name: content, dependencies: {} }),
			);
			yield* fs.writeFileString(path.join(directory, "bun.lock"), lock);
		});
	// Cache/publication tests control the process boundary; frozen Bun install is
	// exercised separately by the runtime preparation process integration tests.
	const commands = PreparationProcess.of({
		install: (directory) =>
			Effect.gen(function* () {
				const manifest =
					(yield* fs.readFileString(path.join(directory, "package.json"))).match(/"name":"([^"]+)"/)?.[1] ?? "invalid";
				const lock = yield* fs.readFileString(path.join(directory, "bun.lock"));
				yield* Ref.update(installs, (items) => [...items, manifest]);
				if (lock === "broken") return yield* new ChildError({ code: "preparation_install_failed" });
				yield* fs.makeDirectory(path.join(directory, "node_modules"));
				yield* fs.writeFileString(path.join(directory, "node_modules/value"), manifest);
			}).pipe(Effect.mapError(() => new ChildError({ code: "preparation_install_failed" }))),
		build: () => Effect.die("No UI build expected"),
	});
	const preparation = yield* GenerationPreparation.pipe(
		Effect.provide(layer({ dataDirectory: root })),
		Effect.provideService(PreparationProcess, commands),
	);
	const snapshot = (name: string) =>
		Effect.gen(function* () {
			const destination = path.join(root, name);
			yield* copySource(source, destination);
			return destination;
		});
	yield* writePackage("", "root");
	return { fs, path, root, source, installs, writePackage, preparation, snapshot };
});

describe("extension dependency preparation", () => {
	it.effect("isolates package dependencies and reuses only matching manifest and lock artifacts", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const env = yield* fixture;
				const { fs, path, source, installs, preparation, writePackage, snapshot } = env;
				yield* writePackage("ext/a", "alpha");
				yield* writePackage("ext/b", "beta");
				// A helper directory containing another package is not an extension.
				yield* writePackage("ext/helper/nested", "ignored");
				const first = yield* snapshot("first");
				yield* preparation.prepare(source, first);
				expect(yield* Ref.get(installs)).toEqual(["root", "alpha", "beta"]);
				for (const [relative, expected] of [
					["", "root"],
					["ext/a", "alpha"],
					["ext/b", "beta"],
				]) {
					expect(yield* fs.readFileString(path.join(first, relative ?? "", "node_modules/value"))).toBe(expected);
				}
				const firstAlpha = yield* fs.realPath(path.join(first, "ext/a/node_modules"));
				const firstBeta = yield* fs.realPath(path.join(first, "ext/b/node_modules"));
				expect(firstAlpha).not.toBe(firstBeta);
				const second = yield* snapshot("second");
				yield* preparation.prepare(source, second);
				expect(yield* Ref.get(installs)).toHaveLength(3);
				expect(yield* fs.realPath(path.join(second, "ext/a/node_modules"))).toBe(firstAlpha);
				yield* writePackage("ext/a", "alpha-updated");
				const third = yield* snapshot("third");
				yield* preparation.prepare(source, third);
				expect(yield* Ref.get(installs)).toEqual(["root", "alpha", "beta", "alpha-updated"]);
				expect(yield* fs.realPath(path.join(third, "ext/a/node_modules"))).not.toBe(firstAlpha);
				expect(yield* fs.realPath(path.join(third, "ext/b/node_modules"))).toBe(firstBeta);
				yield* writePackage("ext/b", "beta", "beta-new-lock");
				const fourth = yield* snapshot("fourth");
				yield* preparation.prepare(source, fourth);
				expect(yield* Ref.get(installs)).toHaveLength(5);
				expect(yield* fs.realPath(path.join(fourth, "ext/b/node_modules"))).not.toBe(firstBeta);
				expect(yield* fs.readFileString(path.join(first, "ext/a/node_modules/value"))).toBe("alpha");
				expect(yield* fs.exists(path.join(source, "ext/a/node_modules"))).toBe(false);
				expect(yield* fs.readDirectory(path.join(env.root, "cache"))).toEqual([]);
			}),
		).pipe(Effect.provide(platform)),
	);

	it.effect("refuses missing or failed package locks without linking partial dependencies or changing source", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fs, path, root, source, preparation, writePackage, snapshot, installs } = yield* fixture;
				yield* writePackage("ext/a", "alpha");
				yield* fs.remove(path.join(source, "ext/a/bun.lock"));
				const missing = yield* snapshot("missing");
				expect(yield* preparation.prepare(source, missing).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SnapshotRejected" },
				});
				expect(yield* fs.exists(path.join(missing, "ext/a/node_modules"))).toBe(false);
				expect(yield* Ref.get(installs)).toEqual(["root"]);
				yield* writePackage("ext/a", "alpha", "broken");
				const failed = yield* snapshot("failed");
				expect(yield* preparation.prepare(source, failed).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { code: "preparation_install_failed" },
				});
				expect(yield* fs.exists(path.join(failed, "ext/a/node_modules"))).toBe(false);
				expect(yield* fs.readDirectory(path.join(root, "prepared/dependencies"))).toHaveLength(1);
				expect(yield* fs.readDirectory(path.join(root, "cache"))).toEqual([]);
				expect(yield* fs.readFileString(path.join(source, "ext/a/package.json"))).toBe(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ name: "alpha", dependencies: {} }),
				);
				expect(yield* fs.readFileString(path.join(source, "ext/a/bun.lock"))).toBe("broken");
			}),
		).pipe(Effect.provide(platform)),
	);
});

it.effect("loads dependency-free packages without locks and still prepares dependencies under a legacy root", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { fs, path, root, source, snapshot } = yield* fixture;
			yield* fs.remove(path.join(source, "package.json"));
			yield* fs.remove(path.join(source, "bun.lock"));
			const dependenciesDirectory = path.join(root, "development-dependencies");
			yield* fs.makeDirectory(dependenciesDirectory);
			yield* fs.makeDirectory(path.join(source, "ext/empty"), { recursive: true });
			yield* fs.writeFileString(
				path.join(source, "ext/empty/package.json"),
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ name: "empty", main: "ignored.js" }),
			);
			const calls = yield* Ref.make(0);
			const preparation = yield* GenerationPreparation.pipe(
				Effect.provide(layer({ dataDirectory: root, dependenciesDirectory })),
				Effect.provideService(
					PreparationProcess,
					PreparationProcess.of({
						install: () => Ref.update(calls, (n) => n + 1),
						build: () => Effect.die("No UI build expected"),
					}),
				),
			);
			const empty = yield* snapshot("empty");
			yield* preparation.prepare(source, empty);
			expect(yield* Ref.get(calls)).toBe(0);
			expect(yield* fs.realPath(path.join(empty, "node_modules"))).toBe(dependenciesDirectory);
			expect(yield* fs.exists(path.join(empty, "ext/empty/node_modules"))).toBe(false);
			for (const content of [
				"null",
				"[]",
				'"invalid"',
				"{",
				'{"dependencies":{}}',
				'{"workspaces":[]}',
				'{"overrides":{}}',
			]) {
				yield* fs.writeFileString(path.join(source, "ext/empty/package.json"), content);
				const candidate = yield* snapshot(`reject-${content.length}-${Buffer.from(content).toString("hex")}`);
				expect(yield* preparation.prepare(source, candidate).pipe(Effect.result)).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SnapshotRejected" },
				});
			}
			expect(yield* Ref.get(calls)).toBe(0);
			// Adding a declared dependency under a manifestless root still invokes preparation.
			yield* fs.writeFileString(path.join(source, "ext/empty/package.json"), '{"dependencies":{}}');
			yield* fs.writeFileString(path.join(source, "ext/empty/bun.lock"), "test process fixture lock");
			const installed = yield* snapshot("installed");
			yield* preparation.prepare(source, installed);
			expect(yield* Ref.get(calls)).toBe(1);
			expect(yield* fs.realPath(path.join(installed, "ext/empty/node_modules"))).toContain("/prepared/dependencies/");
		}),
	).pipe(Effect.provide(platform)),
);

it("resolves a package dependency from retained artifacts and rejects a stale lock through the real keeper", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-package-install-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const execute = promisify(execFile);
	const source = join(root, "app");
	const packageDirectory = join(source, "ext/tool");
	await mkdir(packageDirectory, { recursive: true });
	const manifest = JSON.stringify({ name: "fixture", private: true, dependencies: { "is-number": "7.0.0" } });
	const lock = `{
 "lockfileVersion": 2, "configVersion": 1,
 "workspaces": { "": { "name": "fixture", "dependencies": { "is-number": "7.0.0" } } },
 "packages": { "is-number": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="] }
 }`;
	for (const directory of [source, packageDirectory]) {
		await writeFile(join(directory, "package.json"), manifest);
		await writeFile(join(directory, "bun.lock"), lock);
	}
	// The root has only an alias, so ancestor lookup cannot satisfy is-number.
	await writeFile(
		join(source, "package.json"),
		manifest.replace('"is-number":"7.0.0"', '"root-number":"npm:is-number@7.0.0"'),
	);
	await writeFile(
		join(source, "bun.lock"),
		lock.replaceAll('"is-number":', '"root-number":').replace('"7.0.0"', '"npm:is-number@7.0.0"'),
	);
	await writeFile(
		join(packageDirectory, "index.ts"),
		'import isNumber from "is-number"; console.log(isNumber("123"));',
	);
	const call = (snapshot: string) =>
		execute(
			"bun",
			[join(import.meta.dirname, "fixtures/extension-preparation.ts"), source, join(root, snapshot), root],
			{ timeout: 15000 },
		);
	expect((await call("good")).stdout).toContain('"prepared":true');
	expect((await execute("bun", [join(root, "good/ext/tool/index.ts")])).stdout.trim()).toBe("true");
	const retained = await realpath(join(root, "good/ext/tool/node_modules"));
	expect(retained).toContain(join(root, "prepared/dependencies"));
	await writeFile(join(packageDirectory, "package.json"), manifest.replace("7.0.0", "6.0.0"));
	expect((await call("bad")).stdout).toContain('"prepared":false');
	await expect(realpath(join(root, "bad/ext/tool/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
	// Retained generation source/dependencies work even after writable source is removed.
	await rm(source, { recursive: true });
	expect((await execute("bun", [join(root, "good/ext/tool/index.ts")])).stdout.trim()).toBe("true");
	expect(await readFile(join(root, "good/ext/tool/package.json"), "utf8")).toBe(manifest);
}, 20000);
