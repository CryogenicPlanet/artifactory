import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { PublicPages, layer } from "../../src/public-pages.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing directory");
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(`${root}/pages/guide/child`, { recursive: true });
	yield* fs.writeFileString(`${root}/pages/guide/file.md`, "# Guide");
	yield* fs.writeFileString(`${root}/pages/guide/child/private.md`, "private");
	yield* fs.symlink(`${root}/pages/guide/file.md`, `${root}/pages/guide/link.md`);
	return yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO public_paths VALUES ('guide')`;
		const policy = yield* PublicPages.pipe(Effect.provide(layer(root)));
		const initial = (yield* policy.check("/p/guide/file.md")) !== null;
		const directory = (yield* policy.check("/p/guide/")) !== null;
		const childPrivate = (yield* policy.check("/p/guide/child/private.md")) === null;
		const unsafe = (yield* policy.check("/p/guide/link.md")) === null;
		yield* sql`UPDATE seq SET pending_id='unrelated-app-transaction',pending_attempt='fixture',pending_from=1,pending_to=1`;
		const pending = (yield* policy.check("/p/guide/file.md")) !== null;
		yield* sql`DELETE FROM public_paths`;
		const deleted = (yield* policy.check("/p/guide/file.md")) === null;
		return {
			initial,
			directory,
			childPrivate,
			unsafe,
			pending,
			deleted,
			notCreated: !(yield* fs.exists(`${root}/comms.db`)),
		};
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap((value) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.flatMap(Console.log)),
	),
);
main.pipe(BunRuntime.runMain);
