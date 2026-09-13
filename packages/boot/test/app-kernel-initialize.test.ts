import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
const execute = promisify(execFile);
const Snapshot = Schema.Struct({
	progress: Schema.optionalKey(Schema.String),
	tables: Schema.Array(Schema.String),
	storeId: Schema.String,
	code: Schema.optionalKey(Schema.String),
	permissions: Schema.optionalKey(Schema.Boolean),
	untouched: Schema.optionalKey(Schema.String),
});
const Progress = Schema.Struct({ store_id: Schema.String, next: Schema.Int, active: Schema.NullOr(Schema.String) });
for (const engine of ["pg", "mysql"]) {
	it.skipIf(!process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} resumes the reserved UUID after SIGKILL between app DDL commit and boot progress advancement`,
		async (test) => {
			const directory = process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR;
			if (!directory) throw new Error("Missing private native configurations");
			const script = join(import.meta.dirname, "fixtures/app-kernel-initialize.ts");
			const run = async (mode: string, path = script) => {
				const { stdout } = await execute("bun", [path, directory, engine, mode]);
				return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
			};
			await run("reset");
			const root = await mkdtemp(join(tmpdir(), "comms-initialize-crash-"));
			test.onTestFinished(() => rm(root, { recursive: true, force: true }));
			const boot = join(root, "packages/boot");
			await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
			await mkdir(join(boot, "test/fixtures"), { recursive: true });
			const copy = join(boot, "test/fixtures/app-kernel-initialize.ts");
			await cp(script, copy);
			await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
			const initializer = join(boot, "src/app-kernel-initialize.ts");
			const source = await readFile(initializer, "utf8");
			const needle = "const advanced = { ...saved, next: index + 1, active: null };";
			expect(source.split(needle)).toHaveLength(2);
			await writeFile(
				initializer,
				source.replace(
					needle,
					`if (index === ${engine === "mysql" ? 6 : 0}) process.kill(process.pid, "SIGKILL");\n${needle}`,
				),
			);
			await expect(run("initialize", copy)).rejects.toMatchObject({ signal: "SIGKILL" });
			const interrupted = Schema.decodeUnknownSync(Snapshot)(await run("snapshot"));
			expect(interrupted.tables).toEqual(
				engine === "mysql"
					? ["kernel_migration_intent", "kernel_writer", "mutation_batches", "outbox", "store_identity"]
					: ["kernel_writer"],
			);
			expect(Schema.decodeSync(Schema.fromJsonString(Progress))(interrupted.progress ?? "")).toEqual({
				store_id: interrupted.storeId,
				next: engine === "mysql" ? 6 : 0,
				active: engine === "mysql" ? "table:kernel_migration_intent" : "table:kernel_writer",
			});
			const complete = Schema.decodeUnknownSync(Snapshot)(await run("initialize"));
			expect(complete.storeId).toBe(interrupted.storeId);
			expect(complete.tables).toEqual([
				...(engine === "mysql" ? ["kernel_migration_intent"] : []),
				"kernel_writer",
				"mutation_batches",
				"outbox",
				"store_identity",
			]);
			expect(Schema.decodeSync(Schema.fromJsonString(Progress))(complete.progress ?? "")).toEqual({
				store_id: interrupted.storeId,
				next: engine === "pg" ? 8 : 7,
				active: null,
			});
			const permissions = Schema.decodeUnknownSync(Snapshot)(await run("permissions"));
			expect(permissions.permissions).toBe(true);
		},
		60000,
	);
	it.skipIf(!process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} refuses unowned names, wrong UUIDs, final identity markers and missing completed schema without repair`,
		async () => {
			const directory = process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR;
			if (!directory) throw new Error("Missing private native configurations");
			const run = async (mode: string) => {
				const { stdout } = await execute("bun", [
					join(import.meta.dirname, "fixtures/app-kernel-initialize.ts"),
					directory,
					engine,
					mode,
				]);
				return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
			};
			for (const mode of [
				"foreign",
				"wrong-adoption",
				"ready",
				"missing-completed",
				...(engine === "pg" ? ["foreign-active"] : ["old-ladder"]),
			]) {
				await run("reset");
				const refused = Schema.decodeUnknownSync(Snapshot)(await run(mode));
				expect(refused.code).toBe("app_store_identity_invalid");
				expect(refused.tables).toEqual(
					mode === "old-ladder"
						? ["kernel_writer", "mutation_batches", "outbox", "store_identity"]
						: mode === "foreign-active"
							? ["kernel_writer"]
							: mode === "foreign"
								? ["intruder"]
								: mode === "missing-completed"
									? [
											...(engine === "mysql" ? ["kernel_migration_intent"] : []),
											"kernel_writer",
											"mutation_batches",
											"store_identity",
										]
									: [],
				);
				if (mode !== "missing-completed" && mode !== "foreign-active" && mode !== "old-ladder")
					expect(refused.progress).toBeUndefined();
				if (mode === "foreign-active") expect(refused.untouched).toBe("preserved");
			}
		},
		60000,
	);
}
