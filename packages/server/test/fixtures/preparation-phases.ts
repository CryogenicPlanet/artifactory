import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

/** Observe only disposable boot code. Markers contain no paths, source or credentials. */
export async function preparationPhases(root: string) {
	const boot = join(root, "packages/boot");
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	const launcher = join(boot, "test/fixtures/launcher.ts");
	await cp(join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"), launcher);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	await mkdir(join(root, "packages/server"), { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(root, "packages/server/node_modules"));
	const marker = (phase: string) =>
		`process.stderr.write("COMMS_PREPARATION ${phase} " + Math.round(performance.now()) + "\\n");`;
	const observe = async (file: string, anchors: readonly (readonly [string, string])[]) => {
		const filename = join(boot, "src", file);
		let source = await readFile(filename, "utf8");
		for (const [phase, anchor] of anchors) {
			expect(source.split(anchor).length - 1, `${file}: ${phase} anchor count`).toBe(1);
			source = source.replace(anchor, `${marker(`${phase}_start`)}\n${anchor}\n${marker(`${phase}_done`)}`);
		}
		await writeFile(filename, source);
	};
	await observe("application.ts", [
		["seed_copy", "yield* copySource(options.seedDirectory, app);"],
		["snapshot", "const snapshot = yield* snapshots.create(generation.n);"],
		["preparation", "yield* (yield* GenerationPreparation).prepare(snapshot.directory, snapshot.directory);"],
		["snapshot_record", "yield* generations.setSnapshot(generation.n, snapshot.directory);"],
	]);
	await observe("generation-preparation.ts", [
		["workspace_copy", "yield* copySource(source, work);"],
		["install", "yield* commands.install(work);"],
		["dependency_copy", 'yield* copyPreparedTree(dependencies, path.join(snapshot, "node_modules"), work);'],
		["tree_sync", "yield* syncPreparedTree(snapshot);"],
		[
			"ancestor_sync",
			`let ancestor = path.dirname(snapshot);
								while (true) {
									yield* (yield* fs.open(ancestor)).sync;
									if (ancestor === root) break;
									ancestor = path.dirname(ancestor);
								}`,
		],
	]);
	await observe("supervisor.ts", [
		["prepare_generation", "const choices = yield* prepareGeneration(options);"],
		["candidate_launch", 'const value = yield* launch(generation, recovery.filename, "candidate");'],
		["writer_recovery", "yield* recovery.prepare(value.attempt.epoch);"],
		["child_go", 'yield* value.process.control("go");'],
		["healthy_record", "yield* (yield* Generations).healthy(generation.n);"],
		["candidate_activation", "yield* activate(value);"],
	]);
	return {
		launcher,
		// performance.now() is elapsed since this boot process started. The capture
		// is parsed before teardown; only fixed marker names and numeric time survive.
		read: (output: string) =>
			Array.from(output.matchAll(/^COMMS_PREPARATION ([a-z_]+) ([0-9]+)$/gm))
				.slice(-64)
				.map((match) => ({ phase: match[1], elapsed_ms: Number(match[2]) })),
	};
}
