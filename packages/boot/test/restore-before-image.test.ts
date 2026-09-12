import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";

async function fixture(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-before-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const script = join(import.meta.dirname, "fixtures/restore-before-image.ts");
	const execute = promisify(execFile);
	const run = async (mode: string, payload?: object) =>
		(await execute("bun", [script, root, mode, JSON.stringify(payload ?? {})])).stdout;
	const write = async (suffix: string, bytes: string) => writeFile(join(root, `comms.db${suffix}`), bytes);
	const contents = async (suffix: string) => readFile(join(root, `comms.db${suffix}`), "utf8");
	const artifact = async () =>
		join(root, "restore-before", (await readdir(join(root, "restore-before")))[0] ?? "missing");
	return { root, run, write, contents, artifact };
}

it("restores opaque main and every sidecar byte after restart, retaining the protected original", async (test) => {
	const app = await fixture(test);
	for (const suffix of ["", "-wal", "-shm", "-journal"]) await app.write(suffix, `opaque${suffix}`);
	expect(await app.run("prepare")).toContain('"Success"');
	const artifact = await app.artifact();
	expect((await stat(artifact)).mode & 0o777).toBe(0o700);
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		expect((await stat(join(artifact, `comms.db${suffix}`))).mode & 0o777).toBe(0o600);
		await app.write(suffix, "replacement");
	}
	expect(await app.run("repeat-record")).toContain('"Success"');
	expect(await app.run("rollback")).toContain('"Success"');
	expect(await app.run("rollback")).toContain('"Success"');
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		expect(await app.contents(suffix)).toBe(`opaque${suffix}`);
		expect(await readFile(join(artifact, `comms.db${suffix}`), "utf8")).toBe(`opaque${suffix}`);
	}
});

it("restores absence without touching another database or unrelated files", async (test) => {
	const app = await fixture(test);
	expect(await app.run("prepare")).toContain('"files":[]');
	await writeFile(join(app.root, "other.db"), "retained");
	for (const suffix of ["", "-wal", "-shm", "-journal"]) await app.write(suffix, "new");
	expect(await app.run("rollback")).toContain('"Success"');
	for (const suffix of ["", "-wal", "-shm", "-journal"]) await expect(app.contents(suffix)).rejects.toThrow();
	expect(await readFile(join(app.root, "other.db"), "utf8")).toBe("retained");
	expect(await app.run("rollback")).toContain('"Success"');
});

it.for(["corrupt", "missing", "symlink", "extra"])(
	"refuses %s artifacts before mutating any live file",
	async (mode, test) => {
		const app = await fixture(test);
		await app.write("", "original");
		await app.write("-wal", "original-wal");
		expect(await app.run("prepare")).toContain('"Success"');
		const artifact = await app.artifact();
		if (mode === "corrupt") await writeFile(join(artifact, "comms.db-wal"), "tampered-wal");
		if (mode === "missing" || mode === "symlink") await rm(join(artifact, "comms.db-wal"));
		if (mode === "symlink") await symlink(join(app.root, "comms.db-wal"), join(artifact, "comms.db-wal"));
		if (mode === "extra") await writeFile(join(artifact, "unknown"), "bad");
		await app.write("", "current");
		await app.write("-wal", "current-wal");
		expect(await app.run("rollback")).toContain('"Failure"');
		expect(await app.contents("")).toBe("current");
		expect(await app.contents("-wal")).toBe("current-wal");
	},
);

it.for(["orphan-sidecar", "live-link", "dangling-link", "artifact-link"])(
	"refuses unsafe preparation: %s",
	async (mode, test) => {
		const app = await fixture(test);
		if (mode === "orphan-sidecar") await app.write("-wal", "orphan");
		if (mode === "live-link" || mode === "dangling-link") {
			if (mode === "live-link") await writeFile(join(app.root, "other"), "retained");
			await symlink(join(app.root, "other"), join(app.root, "comms.db"));
		}
		if (mode === "artifact-link") {
			await mkdir(join(app.root, "elsewhere"));
			await symlink(join(app.root, "elsewhere"), join(app.root, "restore-before"));
		}
		expect(await app.run("prepare")).toContain('"Failure"');
	},
);

it("does not authorize rollback before a transaction records the manifest, or permit rebinding", async (test) => {
	const app = await fixture(test);
	await app.write("", "original");
	expect(await app.run("uncommitted")).toContain('"Success"');
	expect(await app.run("rollback")).toContain('"Failure"');
	expect(await app.run("prepare")).toContain('"Success"');
	expect(await app.run("rebind")).toContain('"Failure"');
	expect(await app.run("wrong-store")).toContain('"Failure"');
	expect(await app.contents("")).toBe("original");
});

it.for([{ artifact: "../other" }, { filename: "/tmp/other.db" }, { version: 2 }, { unknown: true }])(
	"refuses malformed manifest %j",
	async (payload, test) => {
		const app = await fixture(test);
		await app.write("", "original");
		expect(await app.run("prepare")).toContain('"Success"');
		await app.run("tamper", payload);
		await app.write("", "current");
		expect(await app.run("rollback")).toContain('"Failure"');
		expect(await app.contents("")).toBe("current");
	},
);

it("retries a SIGKILL between live replacements using retained artifacts", async (test) => {
	const app = await fixture(test);
	await app.write("", "original");
	await app.write("-wal", "original-wal");
	expect(await app.run("prepare")).toContain('"Success"');
	await app.write("", "current");
	await app.write("-wal", "current-wal");
	const boot = join(app.root, "packages/boot");
	await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	const script = join(boot, "test/fixtures/restore-before-image.ts");
	await cp(join(import.meta.dirname, "fixtures/restore-before-image.ts"), script);
	await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
	const sourcePath = join(boot, "src/restore-before-image.ts");
	const source = await readFile(sourcePath, "utf8");
	const needle = "for (const suffix of suffixes) {\n\t\t\t\t\t\tif (manifest.files.some";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		sourcePath,
		source.replace(
			needle,
			'for (const suffix of suffixes) {\n if (suffix === "-wal") { yield* Effect.log("PAUSED"); yield* Effect.never; }\n\t\t\t\t\t\tif (manifest.files.some',
		),
	);
	const child = spawn("bun", [script, app.root, "rollback"], { stdio: ["ignore", "pipe", "pipe"] });
	test.onTestFinished(() => {
		child.kill("SIGKILL");
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	await expect.poll(() => output).toContain("PAUSED");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	expect(await app.contents("")).toBe("original");
	expect(await app.contents("-wal")).toBe("current-wal");
	expect(await app.run("rollback")).toContain('"Success"');
	expect(await app.contents("")).toBe("original");
	expect(await app.contents("-wal")).toBe("original-wal");
});

it("reclaims only unrecorded artifacts and retains historical relocated references", async (test) => {
	const app = await fixture(test);
	await app.write("", "preserved");
	expect(await app.run("prepare")).toContain('"Success"');
	const saved = await app.artifact();
	await app.run("tamper", { filename: "/historical/relocated/store/comms.db" });
	expect(await app.run("uncommitted")).toContain('"Success"');
	expect(await app.run("recover-unrecorded")).toContain('"Success"');
	expect(await readdir(join(app.root, "restore-before"))).toHaveLength(1);
	expect(await readFile(join(saved, "comms.db"), "utf8")).toBe("preserved");
	expect(await app.contents("")).toBe("preserved");
	expect(await app.run("recover-unrecorded")).toContain('"Success"');
});

it.for([
	{ artifact: "../other" },
	{ filename: "comms.db" },
	{ files: [{ suffix: "", bytes: -1, hash: "bad" }] },
	{ extra: true },
])("refuses malformed saved reference before reclaiming any artifact: %j", async (payload, test) => {
	const app = await fixture(test);
	await app.write("", "preserved");
	expect(await app.run("prepare")).toContain('"Success"');
	expect(await app.run("uncommitted")).toContain('"Success"');
	const original = await readdir(join(app.root, "restore-before"));
	await app.run("tamper", payload);
	expect(await app.run("recover-unrecorded")).toContain('"Failure"');
	expect(await readdir(join(app.root, "restore-before"))).toEqual(original);
});

it.for(["link", "nested", "unknown-name"])("refuses unsafe orphan %s before any reclamation", async (mode, test) => {
	const app = await fixture(test);
	await app.write("", "preserved");
	expect(await app.run("uncommitted")).toContain('"Success"');
	expect(await app.run("uncommitted")).toContain('"Success"');
	const original = await readdir(join(app.root, "restore-before"));
	const artifact = await app.artifact();
	if (mode === "link") {
		await rm(join(artifact, "comms.db"));
		await symlink(join(app.root, "comms.db"), join(artifact, "comms.db"));
	}
	if (mode === "nested") await mkdir(join(artifact, "comms.db-wal"));
	if (mode === "unknown-name") await writeFile(join(artifact, "unknown"), "preserved");
	expect(await app.run("recover-unrecorded")).toContain('"Failure"');
	expect(await readdir(join(app.root, "restore-before"))).toEqual(original);
	expect(await app.contents("")).toBe("preserved");
});

it("reclaims a SIGKILL orphan after artifact fsync before manifest recording", async (test) => {
	const app = await fixture(test);
	await app.write("", "original");
	const child = spawn(
		"bun",
		[join(import.meta.dirname, "fixtures/restore-before-image.ts"), app.root, "prepare-pause"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	test.onTestFinished(() => {
		child.kill("SIGKILL");
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	await expect.poll(() => output).toContain("PAUSED");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	expect(await readdir(join(app.root, "restore-before"))).toHaveLength(1);
	expect(await app.run("recover-unrecorded")).toContain('"Success"');
	expect(await readdir(join(app.root, "restore-before"))).toEqual([]);
	expect(await app.contents("")).toBe("original");
});
