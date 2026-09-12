import { Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { sourceIO } from "./source-io.ts";
import { sourceTreeFingerprint } from "./source-tree-publication.ts";
import { SourceRejected } from "./source-schema.ts";

/** Only new source-preserving snapshots can be undone as complete editable trees.
 * Older prepared snapshots may have overwritten source board/ files. */
export const generationSource = Effect.fn("generationSource")(function* (dataDirectory: string, generation: number) {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const unavailable = () => new SourceRejected({ code: "generation_unavailable", path: String(generation) });
	if (!Number.isSafeInteger(generation) || generation < 1) return yield* unavailable();
	const root = yield* fs.realPath(dataDirectory);
	const expected = path.join(root, "gen", String(generation), "source");
	const rows = yield* sql`SELECT snapshot_dir FROM generations WHERE n=${generation}`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ snapshot_dir: Schema.NullOr(Schema.String) }))),
		),
	);
	if (rows[0]?.snapshot_dir !== expected) return yield* unavailable();
	const marker = `${expected}.editable`;
	return yield* Effect.gen(function* () {
		if (
			(yield* fs.realPath(expected)) !== expected ||
			(yield* fs.stat(expected)).type !== "Directory" ||
			(yield* fs.realPath(marker)) !== marker ||
			(yield* fs.stat(marker)).type !== "File" ||
			!(yield* fs.readFileString(marker)).startsWith("1\n")
		)
			return yield* unavailable();
		const inventory = yield* (yield* sourceIO(dataDirectory))
			.inventory(expected)
			.pipe(
				Effect.catchTag("SourceRejected", (error) =>
					Effect.fail(new SourceRejected({ code: "invalid_path", path: error.path })),
				),
			);
		if ((yield* fs.readFileString(marker)) !== sourceTreeFingerprint(inventory)) return yield* unavailable();
		return expected;
	}).pipe(Effect.catchTag("PlatformError", () => Effect.fail(unavailable())));
});
