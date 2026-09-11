import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type TestContext } from "vitest";
import { conversation } from "./conversation.ts";

/** Holds a real app reservation; markers observe the queue without changing gate ownership. */
export async function pagePublicationQueue(test: TestContext) {
	const fixture = await conversation(test);
	const boot = join(fixture.root, "packages/boot");
	const server = join(fixture.root, "packages/server/src");
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(
		join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
		join(boot, "test/fixtures/launcher.ts"),
	);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	await mkdir(join(fixture.root, "packages/server"), { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(fixture.root, "packages/server/node_modules"));
	await cp(join(import.meta.dirname, "../../src"), server, { recursive: true });
	const hold = join(fixture.root, "hold-reservation");
	const reserved = join(fixture.root, "reservation-held");
	const waiting = join(fixture.root, "page-waiting");
	const mutatePath = join(server, "kernel/mutate.ts");
	const mutate = await readFile(mutatePath, "utf8");
	const reserve = "range = yield* boot.reserve(transaction, count);";
	expect(mutate.split(reserve)).toHaveLength(2);
	await writeFile(
		mutatePath,
		mutate.replace(
			reserve,
			`${reserve}
if (!probe) yield* Effect.promise(async () => {
 if (await Bun.file(${JSON.stringify(hold)}).exists()) {
  await Bun.write(${JSON.stringify(reserved)}, String(process.pid));
  while (await Bun.file(${JSON.stringify(hold)}).exists()) await Bun.sleep(10);
 }
});`,
		),
	);
	const indexPath = join(boot, "src/index.ts");
	const index = await readFile(indexPath, "utf8");
	const wait = "// Append needs the channel gate; crashed-child reconciliation needs the operation gate.";
	expect(index.split(wait)).toHaveLength(2);
	await writeFile(
		indexPath,
		index.replace(
			wait,
			`yield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(waiting)}, "waiting");\n${wait}`,
		),
	);
	const marker = async (filename: string) => readFile(filename, "utf8").catch(() => "");
	return {
		...fixture,
		launch: () => fixture.launch(join(server, "server.ts"), join(boot, "test/fixtures/launcher.ts")),
		hold: () => writeFile(hold, "hold"),
		release: () => rm(hold, { force: true }),
		reserved: () => marker(reserved),
		waiting: () => marker(waiting),
	};
}
