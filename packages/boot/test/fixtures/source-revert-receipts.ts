import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { acceptSourceRevert, sourceReverts } from "../../src/source-revert.ts";
import { sourceIO } from "../../src/source-io.ts";
import { sourceJournal } from "../../src/source-journal.ts";
import { layer as eventsLayer } from "../../src/events.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	const mode = process.argv[3];
	if (!root || !mode) return yield* Effect.die("Missing fixture arguments");
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		const receipts = yield* sourceReverts;
		const io = yield* sourceIO(root);
		const journal = yield* sourceJournal(io);
		if (mode.startsWith("recover")) {
			if (mode !== "recover-blocked") yield* journal.recover;
			yield* receipts.recover;
		}
		if (mode === "cancel") {
			yield* receipts
				.run({ family: "fixture", key: "one" }, "selector", Effect.void, () => Effect.interrupt)
				.pipe(Effect.exit);
		}
		const response = yield* receipts.run({ family: "fixture", key: "one" }, "selector", Effect.void, (id) =>
			Effect.gen(function* () {
				if (mode.startsWith("recover") || mode === "cancel")
					return yield* Effect.die("Replay executed the operation again");
				if (mode === "accepted" || mode === "rolled-back") {
					yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* acceptSourceRevert(id, 7);
								if (mode === "rolled-back") return yield* Effect.fail("rollback");
							}),
						)
						.pipe(Effect.ignore);
				} else if (mode.startsWith("page")) {
					yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* journal.begin({ id: "page-batch", lock_id: null, agent: "fixture", at: 1, state: "publishing" }, [
								{
									path: "pages/receipt.md",
									before: yield* io.read("pages/receipt.md"),
									desired: yield* io.image(new TextEncoder().encode("undo"), 0o600),
								},
							]);
							yield* receipts.bindPage(id, "page-batch");
						}),
					);
					if (mode === "page-published") yield* journal.recover;
				}
				// A real process death loses the response and every in-memory request/gate.
				process.kill(process.pid, "SIGKILL");
				return HttpServerResponse.empty();
			}).pipe(Effect.orDie),
		);
		if (response.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
		return {
			status: response.status,
			body: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
				new TextDecoder().decode(response.body.body),
			),
		};
	});
	const result = yield* program.pipe(
		Effect.provide(
			eventsLayer(Effect.void).pipe(Layer.provideMerge(SqliteClient.layer({ filename: `${root}/boot.db` }))),
		),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(result));
});
main.pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
