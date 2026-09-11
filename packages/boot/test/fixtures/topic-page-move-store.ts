import { layer as durableEventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";
import { TopicPageMove, layer as moveLayer } from "../../src/topic-page-move.ts";
import { topicPageMoveSchema } from "../../src/topic-page-move-schema.ts";

import { legacyPageMovePreparation } from "./legacy-page-move-preparation.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const Input = Schema.Struct({
	op: Schema.Literals([
		"prepare",
		"publish",
		"abort",
		"finish",
		"read",
		"recover",
		"prepared_source",
		"abort_with_source",
	]),
	id: Schema.optional(Schema.String),
	from: Schema.optional(Schema.String),
	to: Schema.optional(Schema.String),
	crash: Schema.optional(Schema.Int),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const fs = yield* FileSystem.FileSystem;
	const instrumented = FileSystem.make({
		...fs,
		rename: (from, to) =>
			Effect.gen(function* () {
				if (input.crash === 0) {
					yield* Console.log("BOUNDARY");
					return yield* Effect.never;
				}
				yield* fs.rename(from, to);
				if (input.crash === 1) {
					yield* Console.log("BOUNDARY");
					return yield* Effect.never;
				}
			}),
	});
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		// The coordinator integrates this exported schema in v13; support this isolated fixture before integration.
		if ((yield* sql`SELECT name FROM sqlite_master WHERE name = 'topic_page_moves'`).length === 0)
			yield* topicPageMoveSchema;
		return yield* Effect.gen(function* () {
			const moves = yield* TopicPageMove;
			const prepare = yield* legacyPageMovePreparation(root);
			const files = yield* SourceFiles;
			const id = input.id ?? "move-one";
			if (input.op === "prepare") return yield* prepare(id, input.from ?? "old", input.to ?? "new/target", "human");
			if (input.op === "publish") yield* moves.publish(id);
			if (input.op === "abort") yield* moves.abort(id);
			if (input.op === "finish") yield* moves.finish(id);
			if (input.op === "read") return yield* files.browse("pages");
			if (input.op === "recover") return yield* files.recover;
			if (input.op === "abort_with_source") {
				const proposal = yield* files.preparePages("human", [
					{ path: "pages/other.md", content: new TextEncoder().encode("other") },
				]);
				yield* moves.abort("absent");
				yield* files.publish(proposal);
			}
			if (input.op === "prepared_source") {
				yield* files.preparePages("human", [{ path: "pages/other.md", content: new TextEncoder().encode("other") }]);
				return yield* prepare(id, "old", "new/target", "human");
			}
			return null;
		}).pipe(
			Effect.provide(moveLayer(root).pipe(Layer.provideMerge(sourceLayer(root).pipe(Layer.provideMerge(lockLayer))))),
		);
	}).pipe(
		Effect.catchTags({
			SourceRejected: (error) => Effect.succeed({ error: error.code, path: error.path }),
			SqlError: () => Effect.succeed({ error: "sql_error" }),
		}),
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.provideService(FileSystem.FileSystem, instrumented),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
});
main.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
