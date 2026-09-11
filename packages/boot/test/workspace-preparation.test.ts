import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("freezes workspace packages before Vite and serves the snapshot without its source or build workspace", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-workspace-preparation-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "app");
	await mkdir(join(source, "protocol"), { recursive: true });
	await mkdir(join(source, "ui"));
	await writeFile(
		join(source, "package.json"),
		JSON.stringify({
			name: "workspace-fixture",
			type: "module",
			private: true,
			workspaces: ["protocol"],
			dependencies: { "@fixture/protocol": "workspace:*", vite: "8.2.2" },
			comms: { board_directory: "environment-v1" },
		}),
	);
	await writeFile(
		join(source, "protocol/package.json"),
		JSON.stringify({
			name: "@fixture/protocol",
			version: "1.0.0",
			type: "module",
			exports: "./index.ts",
			bin: { "workspace-tool": "./bin.ts" },
		}),
	);
	await writeFile(join(source, "protocol/bin.ts"), 'import { value } from "./index.ts"; console.log(value);');
	await writeFile(join(source, "protocol/index.ts"), 'export const value = "captured workspace";');
	await writeFile(
		join(source, "ui/index.html"),
		'<html><body><script type="module" src="/main.ts"></script></body></html>',
	);
	await writeFile(
		join(source, "ui/main.ts"),
		'import { value } from "@fixture/protocol"; document.body.textContent = value;',
	);
	await writeFile(
		join(source, "ui/vite.config.ts"),
		`import { writeFileSync } from "node:fs";
writeFileSync(new URL("../protocol/index.ts", import.meta.url), 'export const value = "build workspace mutation";');
export default {};`,
	);
	await writeFile(
		join(source, "server.ts"),
		`import { value } from "@fixture/protocol";
const server = Bun.serve({port:0, fetch:()=>new Response(value)});
console.log(server.url.toString());`,
	);
	const execute = promisify(execFile);
	await execute("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: source, timeout: 60000 });
	const snapshot = join(root, "snapshot");
	const prepared = await execute(
		"bun",
		[join(import.meta.dirname, "fixtures/extension-preparation.ts"), source, snapshot, root],
		{ timeout: 120000 },
	);
	expect(prepared.stdout, prepared.stderr).toContain('"prepared":true');
	expect((await execute("bun", [join(snapshot, "node_modules/.bin/workspace-tool")])).stdout.trim()).toBe(
		"captured workspace",
	);
	const saved = join(snapshot, "node_modules/@fixture/protocol/index.ts");
	expect(await readFile(saved, "utf8")).toContain("captured workspace");
	expect((await stat(saved)).ino).not.toBe((await stat(join(source, "protocol/index.ts"))).ino);
	expect(await readFile(join(source, "protocol/index.ts"), "utf8")).toContain("captured workspace");
	const assets = await readdir(`${snapshot}.board/assets`);
	const script = assets.find((name) => name.endsWith(".js"));
	expect(script).toBeDefined();
	expect(await readFile(join(`${snapshot}.board/assets`, script ?? "missing"), "utf8")).toContain(
		"build workspace mutation",
	);
	expect(await readdir(join(root, "cache"))).toEqual([]);
	await rm(source, { recursive: true });
	await rm(join(root, "cache"), { recursive: true });
	const server = spawn("bun", [join(snapshot, "server.ts")], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	server.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	test.onTestFinished(async () => {
		server.kill("SIGTERM");
		await expect.poll(() => server.exitCode !== null || server.signalCode !== null).toBe(true);
	});
	await expect.poll(() => output.trim()).toMatch(/^http:\/\//);
	expect(await (await fetch(output.trim())).text()).toBe("captured workspace");
}, 150000);
