import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { PublicPages, layer as publicPagesLayer } from "../../src/public-pages.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const result = yield* Effect.gen(function* () {
			return yield* (yield* PublicPages).check(process.argv[3] ?? "/p/");
		}).pipe(Effect.provide(publicPagesLayer(root)), Effect.result);
		yield* Console.log(
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
				result._tag === "Success"
					? { _tag: "Success", success: result.success }
					: { _tag: "Failure", failure: result.failure },
			),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
