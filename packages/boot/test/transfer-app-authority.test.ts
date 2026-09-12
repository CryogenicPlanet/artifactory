import { ByteSize, Effect, FileSystem, Option, Path } from "effect";
import { describe, expect, it } from "vitest";
import type { ChildConfiguration } from "../src/keeper-configuration.ts";
import { prepareApp } from "../src/linux-ownership.ts";
import { authorizeTransferApp } from "../src/transfer-app-authority.ts";

const id = "12345678-1234-4234-8234-123456789abc";
const attempt = "a".repeat(64);
const cwd = "/data/gen/1/source";
const config = (): typeof ChildConfiguration.Type => ({
	cwd,
	entry: `${cwd}/transfer-app-worker.ts`,
	attempt,
	receipt: `/data/attempts/${attempt}.closed`,
	env: {
		STATE: "transfer",
		TRANSFER_ID: id,
		WRITER_EPOCH: "b".repeat(64),
		APP_STORE: "file:/data/store/comms.db",
		TRANSFER_APP_RESULT: `/data/rehearsals/transfer-${attempt}/result.json`,
	},
});
const journal = () => ({
	phase: "preparing",
	sentinel: "ready",
	epoch: "b".repeat(64),
	initialized_at: 1,
	selection: {
		version: 1,
		transfer_id: id,
		data_directory: "/data",
		store_id: id,
		source: { engine: "pg", endpoint: "localhost:5432", boot: "boot", app: "app" },
		target: { engine: "sqlite", endpoint: null, boot: "/data/boot.db", app: "/data/store/comms.db" },
	},
});
function filesystem(value: unknown, options: { linked?: boolean; mode?: number; uid?: number } = {}) {
	return FileSystem.makeNoop({
		realPath: (path) => Effect.succeed(options.linked ? `${path}-link` : path),
		stat: (path) =>
			Effect.succeed({
				type: path.endsWith(".json") ? "File" : "Directory",
				mtime: Option.none(),
				atime: Option.none(),
				birthtime: Option.none(),
				dev: 1,
				ino: Option.some(1),
				mode: options.mode ?? 0o700,
				nlink: Option.some(1),
				uid: Option.some(options.uid ?? 1000),
				gid: Option.some(1000),
				rdev: Option.none(),
				size: ByteSize.bytes(100),
				blksize: Option.none(),
				blocks: Option.none(),
			}),
		readFileString: () => Effect.succeed(JSON.stringify(value)),
	});
}
const run = (child = config(), saved: unknown = journal(), options: Parameters<typeof filesystem>[1] = {}) =>
	Effect.runPromise(
		authorizeTransferApp(child).pipe(Effect.provideService(FileSystem.FileSystem, filesystem(saved, options))),
	);

describe("offline migration keeper authority", () => {
	it("accepts only the prepared target and canonical scratch target", async () => {
		expect((await run())._tag).toBe("file");
		const saved = journal();
		saved.selection.target.app = `/data/rehearsals/transfer-check-${id}/comms.db`;
		const child = { ...config(), env: { ...config().env, APP_STORE: `file:${saved.selection.target.app}` } };
		expect((await run(child, saved))._tag).toBe("file");
	});
	it("binds both remote descriptors and target ownership namespace", async () => {
		const saved = {
			...journal(),
			selection: {
				...journal().selection,
				source: { engine: "sqlite", endpoint: null, boot: "/data/boot.db", app: "/data/store/comms.db" },
				target: { engine: "pg", endpoint: "localhost:5432", boot: "target_boot", app: "target_app" },
			},
		};
		const child = {
			...config(),
			env: { ...config().env, APP_STORE: "postgres://app:pass@localhost/target_app" },
			remote: {
				root: "/boot",
				dataDirectory: `/data/transfers/${id}/target-owners`,
				bootStore: "postgres://boot:pass@localhost/target_boot",
				tls: true,
				guardian: { url: "http://127.0.0.1:1234", secret: "c".repeat(64), attempt },
			},
		};
		expect((await run(child, saved))._tag).toBe("postgres");
		const ipv6 = {
			...child,
			env: { ...child.env, APP_STORE: "postgres://app:pass@[::1]/target_app" },
			remote: { ...child.remote, bootStore: "postgres://boot:pass@[::1]/target_boot" },
		};
		expect(
			(
				await run(ipv6, {
					...saved,
					selection: { ...saved.selection, target: { ...saved.selection.target, endpoint: "[::1]:5432" } },
				})
			)._tag,
		).toBe("postgres");
		for (const remote of [
			{ ...child.remote, dataDirectory: "/data" },
			{ ...child.remote, bootStore: "postgres://app:pass@localhost/target_boot" },
			{ ...child.remote, bootStore: "postgres://boot:pass@localhost/other" },
		])
			await expect(run({ ...child, remote }, saved)).rejects.toThrow();
	});

	it("refuses wrong epoch, namespace, target, result, or worker before launching", async () => {
		for (const env of [
			{ WRITER_EPOCH: "c".repeat(64) },
			{ TRANSFER_ID: `${id}\n` },
			{ APP_STORE: "file:/data/boot.db" },
			{ TRANSFER_APP_RESULT: `/data/transfers/${id}/result.json` },
		])
			await expect(run({ ...config(), env: { ...config().env, ...env } })).rejects.toThrow("store_descriptor_mismatch");
		await expect(run({ ...config(), entry: `${cwd}/server.ts` })).rejects.toThrow();
	});
	it("refuses missing readiness and completed or copied-data journals", async () => {
		await expect(run(config(), { ...journal(), sentinel: "pending" })).rejects.toThrow();
		for (const phase of ["in_progress", "complete"])
			await expect(
				run(config(), { binding: { ...journal().selection, manifest: "d".repeat(64) }, phase }),
			).rejects.toThrow();
	});
	it("refuses links and journals readable or owned by editable users", async () => {
		for (const options of [{ linked: true }, { mode: 0o750 }, { uid: 1001 }])
			await expect(run(config(), journal(), options)).rejects.toThrow();
	});
});

describe("offline migration Linux ownership", () => {
	it("only shares selected SQLite files and a fresh output directory", async () => {
		for (const scratch of [false, true]) {
			const saved = journal();
			if (scratch) saved.selection.target.app = `/data/rehearsals/transfer-check-${id}/comms.db`;
			const filename = saved.selection.target.app;
			const child = { ...config(), env: { ...config().env, APP_STORE: `file:${filename}` } };
			const changes: { path: string; mode?: number; uid?: number; gid?: number }[] = [];
			const base = filesystem(saved);
			const fs = FileSystem.makeNoop({
				...base,
				exists: (path) => Effect.succeed(path === "/data/pages" || path.startsWith(filename)),
				readDirectory: () => Effect.succeed([]),
				stat: (path) =>
					base.stat(path).pipe(
						Effect.map((stat) => ({
							...stat,
							type: path.startsWith(filename) || path.endsWith(".ts") || path.endsWith(".json") ? "File" : "Directory",
							mode: path === "/data/rehearsals" ? 0o711 : stat.mode,
						})),
					),
				chown: (path, uid, gid) =>
					Effect.sync(() => {
						changes.push({ path, uid, gid });
					}),
				chmod: (path, mode) =>
					Effect.sync(() => {
						changes.push({ path, mode });
					}),
			});
			await Effect.runPromise(
				prepareApp(child).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer)),
			);
			expect(changes.some(({ path }) => path.startsWith("/data/transfers") || path.startsWith("/data/pages"))).toBe(
				false,
			);
			expect(changes).toContainEqual({ path: `/data/rehearsals/transfer-${attempt}`, uid: 1001, gid: 1003 });
			expect(changes).toContainEqual({ path: `${filename}-journal`, mode: 0o660 });
			if (scratch) expect(changes).toContainEqual({ path: `/data/rehearsals/transfer-check-${id}`, mode: 0o770 });
		}
	});
	it("refuses an app-controlled parent or reused result directory before changing permissions", async () => {
		for (const reused of [false, true]) {
			const changes: string[] = [];
			const base = filesystem(journal());
			const fs = FileSystem.makeNoop({
				...base,
				stat: (path) =>
					base.stat(path).pipe(
						Effect.map((stat) => ({
							...stat,
							uid: Option.some(path === "/data/rehearsals" && !reused ? 1001 : 1000),
							mode: path === "/data/rehearsals" ? 0o711 : stat.mode,
						})),
					),
				readDirectory: () => Effect.succeed(["result.json"]),
				chown: (path) =>
					Effect.sync(() => {
						changes.push(path);
					}),
				chmod: (path) =>
					Effect.sync(() => {
						changes.push(path);
					}),
			});
			await expect(
				Effect.runPromise(
					prepareApp(config()).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(Path.layer)),
				),
			).rejects.toThrow();
			expect(changes).toEqual([]);
		}
	});
});
