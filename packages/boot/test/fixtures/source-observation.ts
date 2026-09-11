import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as lockLayer } from "../../src/edit-lock.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";
import { initializeSourceBaseline } from "../../src/source-observation.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const operation = process.argv[3] ?? "observe";
	const selectedBatch = process.argv[4];
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		if (operation === "baseline") {
			yield* initializeSourceBaseline(root);
			return null;
		}
		return yield* Effect.gen(function* () {
			const files = yield* SourceFiles;
			if (operation === "observe") return yield* files.observe;
			const fs = yield* FileSystem.FileSystem;
			const lock = yield* EditLock;
			const holder = (yield* lock.acquire("boot:watcher", operation.startsWith("undo") ? "codex" : "watcher")).value;
			const owner = { id: holder.id, family: holder.holder_family };
			const proposal = yield* operation.startsWith("undo")
				? files.prepareUndo(
						owner,
						operation === "undo" ? { path: "app/main.ts" } : selectedBatch ? { batch: selectedBatch } : {},
					)
				: files.prepareWatcher(owner);
			if (proposal === null) return { unchanged: true };
			if (operation === "race") yield* fs.writeFileString(`${root}/app/later.txt`, "later edit");
			const materialized = yield* files.materialize(proposal);
			const captured = yield* fs.readFileString(`${materialized}/app/main.ts`);
			const laterIncluded = yield* fs.exists(`${materialized}/app/later.txt`);
			const emptyIncluded = yield* fs.exists(`${materialized}/app/empty`);
			const published = yield* files.publish(proposal).pipe(Effect.result);
			if (published._tag === "Success") yield* lock.finish(owner, { succeeded: true, release: true });
			else {
				yield* files.discard(proposal);
				yield* lock.release(owner);
			}
			return { captured, laterIncluded, emptyIncluded, published };
		}).pipe(Effect.provide(sourceLayer(root).pipe(Layer.provideMerge(lockLayer))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })), Effect.result);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
