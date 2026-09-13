import { ByteSize, Effect, FileSystem, Option, Path } from "effect";
import { expect, it } from "vitest";
import { prepareApp } from "../src/linux-ownership.ts";

const attempt = "a".repeat(64);
const configuration = (env: Readonly<Record<string, string>>) => ({
	entry: "/data/gen/1/source/server.ts",
	cwd: "/data/gen/1/source",
	attempt,
	receipt: `/data/attempts/${attempt}.closed`,
	env,
});

function filesystem() {
	const authorized: string[] = [];
	const copied: Array<readonly [string, string]> = [];
	const fs = FileSystem.makeNoop({
		realPath: (name) => Effect.succeed(name),
		stat: (name) =>
			Effect.succeed({
				type: name.endsWith(".ts") || name.endsWith(".db") ? "File" : "Directory",
				mtime: Option.none(),
				atime: Option.none(),
				birthtime: Option.none(),
				dev: 0,
				ino: Option.none(),
				mode: 0o700,
				nlink: Option.none(),
				uid: Option.none(),
				gid: Option.none(),
				rdev: Option.none(),
				size: ByteSize.zero,
				blksize: Option.none(),
				blocks: Option.none(),
			}),
		exists: (name) => Effect.succeed(name.endsWith(".db")),
		readDirectory: () => Effect.succeed([]),
		chown: (name) =>
			Effect.sync(() => {
				authorized.push(name);
			}),
		chmod: () => Effect.void,
		makeDirectory: () => Effect.void,
		copyFile: (from, to) =>
			Effect.sync(() => {
				copied.push([from, to]);
			}),
	});
	const run = (env: Readonly<Record<string, string>>) =>
		Effect.runPromise(
			prepareApp(configuration(env)).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer)),
		);
	return { run, authorized, copied };
}

it("keeper accepts descriptor-only and alias-only live selections before authorizing the same file", async () => {
	for (const env of [{ APP_DATABASE: "/data/store/comms.db" }, { APP_STORE: "file:/data/store/comms.db" }]) {
		const fixture = filesystem();
		const result = await fixture.run(env);
		expect(result.env).toMatchObject({ ...env, TMPDIR: "/data/runtime", HOME: "/data/runtime" });
		expect(fixture.authorized).toContain("/data/store/comms.db");
		expect(fixture.copied).toEqual([]);
	}
});

it("keeper rewrites both aliases after copying a rehearsal selected by either contract", async () => {
	for (const selection of [
		{ APP_DATABASE: "/data/proposal/rehearsal.db" },
		{ APP_STORE: "file:/data/proposal/rehearsal.db" },
	]) {
		const fixture = filesystem();
		const result = await fixture.run({ ...selection, STATE: "rehearsal" });
		const filename = `/data/rehearsals/${attempt}/comms.db`;
		expect(result.env).toMatchObject({ APP_STORE: `file:${filename}`, APP_DATABASE: filename });
		expect(fixture.copied).toEqual([["/data/proposal/rehearsal.db", filename]]);
	}
});

it("keeper rejects absent, malformed and conflicting selections before any ownership change without exposing values", async () => {
	for (const [env, message] of [
		[{}, "APP_STORE or APP_DATABASE: store_descriptor_invalid"],
		[{ APP_DATABASE: "relative-secret.db" }, "APP_DATABASE: store_descriptor_invalid"],
		[{ APP_STORE: "mysql://private-secret@host/db" }, "APP_STORE: store_engine_unsupported"],
		[
			{ APP_STORE: "file:/data/store/comms.db", APP_DATABASE: "/data/private-secret.db" },
			"APP_STORE: store_descriptor_mismatch",
		],
	] as const) {
		const fixture = filesystem();
		const failure = await fixture.run(env).then(
			() => "",
			(error: unknown) => String(error),
		);
		expect(failure).toContain(message);
		expect(failure).not.toContain("secret");
		expect(fixture.authorized).toEqual([]);
		expect(fixture.copied).toEqual([]);
	}
});
