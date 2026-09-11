import { layer as eventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Crypto, Effect, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { sourceIO } from "../../src/source-io.ts";
import { sourceJournal } from "../../src/source-journal.ts";
import type { Change, Image } from "../../src/source-schema.ts";

const Input = Schema.Struct({
	op: Schema.Literals(["init", "publish", "file_publish", "tree_undo", "plan"]),
	selection: Schema.optionalKey(
		Schema.Struct({
			path: Schema.optionalKey(Schema.String),
			batch: Schema.optionalKey(Schema.String),
			version: Schema.optionalKey(Schema.Int),
			generation: Schema.optionalKey(Schema.Int),
			retry: Schema.optionalKey(Schema.Struct({ family: Schema.String, key: Schema.String })),
		}),
	),
	desired: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				path: Schema.String,
				content: Schema.NullOr(Schema.String),
				directory: Schema.optionalKey(Schema.Literal(true)),
				mode: Schema.optionalKey(Schema.Int),
				repeat: Schema.optionalKey(Schema.Int),
			}),
		),
	),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		if (input.op === "init") return null;
		const io = yield* sourceIO(root);
		const journal = yield* sourceJournal(io);
		const crypto = yield* Crypto.Crypto;
		const before = new Map((yield* io.inventory()).map((entry) => [entry.path, entry.image]));
		const desired = new Map<string, Image>();
		if (input.op === "tree_undo" || input.op === "plan") {
			const plan = yield* journal.treeUndo(input.selection ?? {});
			if (plan === null) return null;
			if (input.op === "plan")
				return {
					roots: plan.roots,
					entries: plan.entries.map((entry) => ({
						path: entry.path,
						image: {
							...entry.image,
							content: entry.image.content === null ? null : new TextDecoder().decode(entry.image.content),
						},
					})),
				};
			for (const [name, image] of before)
				if (!plan.roots.some((root) => name === root || name.startsWith(`${root}/`))) desired.set(name, image);
			for (const entry of plan.entries) desired.set(entry.path, entry.image);
		} else {
			for (const entry of input.desired ?? [])
				desired.set(
					entry.path,
					entry.directory
						? { directory: true, content: null, sha: null, mode: null }
						: yield* io.image(
								entry.content === null ? null : new TextEncoder().encode(entry.content.repeat(entry.repeat ?? 1)),
								entry.mode ?? 0o640,
							),
				);
		}
		const absent = yield* io.image(null, null);
		const names =
			input.op === "file_publish" ? [...desired.keys()] : [...new Set([...before.keys(), ...desired.keys()])];
		const changes: Change[] = names
			.sort()
			.map((path) => ({ path, before: before.get(path) ?? absent, desired: desired.get(path) ?? absent }));
		const id = yield* crypto.randomUUIDv4;
		yield* journal.begin({ id, lock_id: null, agent: "codex", at: 1, state: "publishing" }, changes);
		return { batch: yield* journal.recover };
	}).pipe(
		Effect.catchTags({
			SourceRejected: (error) => Effect.succeed({ error: error.code, path: error.path }),
			SqlError: () => Effect.succeed({ error: "sql_error" }),
		}),
		Effect.provide(eventsLayer(Effect.void)),
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
