import { layer as eventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { sourceIO } from "../../src/source-io.ts";
import { sourceJournal } from "../../src/source-journal.ts";
import type { Change, Image } from "../../src/source-schema.ts";

const Input = Schema.Struct({
	op: Schema.Literals(["init", "publish", "recover"]),
	crash: Schema.optional(Schema.Int),
	desired: Schema.optional(
		Schema.Array(
			Schema.Struct({
				path: Schema.String,
				content: Schema.NullOr(Schema.String),
				directory: Schema.optional(Schema.Literal(true)),
				mode: Schema.optional(Schema.Int),
			}),
		),
	),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const fs = yield* FileSystem.FileSystem;
	const mutations: string[] = [];
	const directories = new Set<string>();
	const mark = (name: string) =>
		Effect.gen(function* () {
			if (!(name === `${root}/app` || name.startsWith(`${root}/app/`)) || name.includes("/.comms-")) return;
			mutations.push(name);
			if (mutations.length === input.crash) {
				yield* Console.log("JOURNALED");
				return yield* Effect.never;
			}
		});
	const instrumented = FileSystem.make({
		...fs,
		// Native atomic rmdir is observed before the following parent fsync, so SIGKILL
		// exercises the unsynced directory-removal boundary too.
		open: (name, options) =>
			Effect.gen(function* () {
				for (const directory of directories)
					if (!(yield* fs.exists(directory))) {
						directories.delete(directory);
						yield* mark(directory);
					}
				return yield* fs.open(name, options);
			}),
		remove: (name, options) => fs.remove(name, options).pipe(Effect.tap(() => mark(name))),
		makeDirectory: (name, options) => fs.makeDirectory(name, options).pipe(Effect.tap(() => mark(name))),
		rename: (from, to) => fs.rename(from, to).pipe(Effect.tap(() => mark(to))),
	});
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		if (input.op === "init") return null;
		const io = yield* sourceIO(root);
		const journal = yield* sourceJournal(io);
		if (input.op === "publish") {
			const before = new Map((yield* io.inventory()).map((entry) => [entry.path, entry.image]));
			for (const [name, image] of before) if (image.directory) directories.add(`${root}/${name}`);
			const desired = new Map<string, Image>();
			for (const entry of input.desired ?? [])
				desired.set(
					entry.path,
					entry.directory
						? { directory: true, content: null, sha: null, mode: null }
						: yield* io.image(
								entry.content === null ? null : new TextEncoder().encode(entry.content),
								entry.mode ?? 0o640,
							),
				);
			const absent = yield* io.image(null, null);
			const changes: Change[] = [...new Set([...before.keys(), ...desired.keys()])].sort().map((path) => ({
				path,
				before: before.get(path) ?? absent,
				desired: desired.get(path) ?? absent,
			}));
			yield* journal.begin({ id: "tree-batch", lock_id: null, agent: "codex", at: 1, state: "publishing" }, changes);
			if (input.crash === 0) {
				yield* Console.log("JOURNALED");
				return yield* Effect.never;
			}
		}
		return { batch: yield* journal.recover, mutations };
	}).pipe(
		Effect.catchTags({
			SourceRejected: (error) => Effect.succeed({ error: error.code, path: error.path }),
			SqlError: () => Effect.succeed({ error: "sql_error" }),
		}),
		Effect.provide(eventsLayer(Effect.void)),
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.provideService(FileSystem.FileSystem, instrumented),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
