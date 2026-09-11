import { layer as durableEventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const Input = Schema.Struct({
	op: Schema.Literals([
		"browse",
		"publish",
		"undo",
		"page_undo",
		"recover",
		"read",
		"history",
		"previous",
		"conditional",
		"prepare_failure",
		"init",
	]),
	holder: Schema.optional(Schema.Boolean),
	path: Schema.optional(Schema.String),
	batch: Schema.optional(Schema.String),
	crash: Schema.optional(Schema.Int),
	writes: Schema.optional(
		Schema.Array(
			Schema.Struct({
				path: Schema.String,
				content: Schema.NullOr(Schema.String),
				repeat: Schema.optional(Schema.Int),
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
	let renames = 0;
	const syncs: string[] = [];
	const instrumented = FileSystem.make({
		...fs,
		rename: (from, to) =>
			Effect.gen(function* () {
				if (to.includes("/.proposal-")) return yield* fs.rename(from, to);
				if (input.crash === 0 && renames === 0) {
					yield* Console.log("JOURNALED");
					return yield* Effect.never;
				}
				yield* fs.rename(from, to);
				renames++;
				if (input.crash === renames) {
					yield* Console.log("JOURNALED");
					return yield* Effect.never;
				}
			}),
		open: (name, options) =>
			fs.open(name, options).pipe(
				Effect.map((handle) => ({
					[FileSystem.FileTypeId]: handle[FileSystem.FileTypeId],
					stat: handle.stat,
					seek: handle.seek.bind(handle),
					read: handle.read.bind(handle),
					readAlloc: handle.readAlloc.bind(handle),
					truncate: handle.truncate.bind(handle),
					write: handle.write.bind(handle),
					writeAll: handle.writeAll.bind(handle),
					sync: Effect.tap(handle.sync, () =>
						Effect.sync(() => {
							syncs.push(name);
						}),
					),
				})),
			),
	});
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const files = yield* SourceFiles;
			const lock = yield* EditLock;
			const name = input.path ?? "app/main.ts";
			if (input.op === "init") return null;
			if (input.op === "recover") return { batch: yield* files.recover, syncs };
			if (input.op === "read") {
				const result = yield* files.read(name);
				return { ...result, content: result.content === null ? null : new TextDecoder().decode(result.content) };
			}
			if (input.op === "browse") {
				if (!input.holder) return yield* files.browse(name);
				const holder = (yield* lock.acquire("one", "codex")).value;
				const owner = { id: holder.id, family: holder.holder_family };
				for (const write of input.writes ?? [])
					yield* files.stage(
						owner,
						write.path,
						write.content === null ? null : new TextEncoder().encode(write.content),
					);
				return yield* files.browse(name, owner);
			}
			if (input.op === "history") return yield* files.history(name);
			if (input.op === "previous") return yield* files.previous(input.batch ?? "");
			if (input.op === "page_undo") {
				const id = yield* files.preparePageUndo("codex", { batch: input.batch ?? "" });
				if (id === null) return { error: "not_pages" };
				yield* files.publish(id);
				return { batch: id, syncs };
			}
			if (
				input.op === "publish" &&
				input.writes &&
				input.writes.length > 0 &&
				input.writes.every((write) => write.path.startsWith("pages/"))
			) {
				const id = yield* files.preparePages(
					"codex",
					input.writes.map((write) => ({
						path: write.path,
						content: write.content === null ? null : new TextEncoder().encode(write.content.repeat(write.repeat ?? 1)),
						...(write.mode === undefined ? {} : { mode: write.mode }),
					})),
				);
				yield* files.publish(id);
				return { batch: id, syncs };
			}
			const holder = (yield* lock.acquire("one", "codex")).value;
			const owner = { id: holder.id, family: holder.holder_family };
			if (input.op === "conditional") {
				const start = yield* files.read(name, owner);
				const bytes = (value: string) => new TextEncoder().encode(value);
				yield* files.stage(owner, name, bytes("two"), start.sha);
				const stale = yield* files.stage(owner, name, bytes("three"), start.sha).pipe(Effect.result);
				const current = yield* files.read(name, owner);
				const concurrent = yield* Effect.forEach(
					["first", "second"],
					(value) => files.stage(owner, name, bytes(value), current.sha).pipe(Effect.result),
					{ concurrency: 2 },
				);
				const existing = yield* files.stage(owner, name, bytes("overwrite"), null).pipe(Effect.result);
				yield* files.stage(owner, "app/new.bin", new Uint8Array([0, 255, 128]), null);
				return {
					stale,
					concurrent,
					existing,
					disk: new TextDecoder().decode((yield* files.read(name)).content ?? new Uint8Array()),
					binary: Array.from((yield* files.read("app/new.bin", owner)).content ?? []),
				};
			}
			if (input.op === "prepare_failure") {
				yield* lock.stage(owner, "app/link/file.ts", new TextEncoder().encode("bad"));
				const failed = yield* files.prepare(owner).pipe(Effect.result);
				return { failed, lock: (yield* lock.inspect).value };
			}
			let id: string;
			if (input.op === "undo") id = yield* files.prepareUndo(owner, input.batch ?? "");
			else {
				const writes = (input.writes ?? []).map((write) => ({
					path: write.path,
					content: write.content === null ? null : new TextEncoder().encode(write.content.repeat(write.repeat ?? 1)),
					...(write.mode === undefined ? {} : { mode: write.mode }),
				}));
				if (writes.length > 0 && writes.every((write) => write.path.startsWith("pages/")))
					id = yield* files.preparePages("codex", writes);
				else {
					for (const write of writes) yield* files.stage(owner, write.path, write.content);
					id = yield* files.prepare(owner);
				}
			}
			const proposed = yield* Effect.scoped(
				Effect.gen(function* () {
					const dir = yield* files.materialize(id);
					return (yield* fs.readDirectory(`${dir}/app`)).sort();
				}),
			);
			yield* files.publish(id);
			if ((yield* lock.inspect).value?.cutover_in_flight) yield* lock.finish(owner, { succeeded: true });
			return { batch: id, proposed, syncs };
		}).pipe(Effect.provide(sourceLayer(root).pipe(Layer.provideMerge(lockLayer))));
	}).pipe(
		Effect.catchTags({
			SourceRejected: (error) => Effect.succeed({ error: error.code, path: error.path }),
			EditRejected: (error) => Effect.succeed({ error: error.code }),
			SqlError: (error) => Effect.succeed({ error: "sql_error", message: error.message }),
		}),
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.provideService(FileSystem.FileSystem, instrumented),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
