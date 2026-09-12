import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "@comms/storage/client";
import { transferInventory } from "@comms/storage/transfer-inventory";
import { eventsSchema } from "../../../boot/src/events.ts";
import { eventRoutingSchema, eventFilterSchema } from "../../../boot/src/boot-schema.ts";
import { logicalTransferPlan } from "../../src/transfer/logical-plan.ts";
const filename = process.argv[2];
if (!filename) throw Error("Missing private fixture database");
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* eventsSchema;
		yield* eventRoutingSchema;
		yield* eventFilterSchema;
		const inventory = yield* transferInventory(sql);
		const { tables: plans } = yield* logicalTransferPlan({
			store: "boot",
			source: { engine: "sqlite", inventory },
			target: { engine: "sqlite", inventory },
		});
		const events = plans.find((plan) => plan.name === "events");
		if (events?.columns.map((column) => column.name).join(",") !== "event,seq,topic,transaction_id")
			return yield* Effect.die("Unexpected logical event projection");
		if (plans[0]?.name !== "seq") return yield* Effect.die("Allocator was not first");
		process.stdout.write("catalog verified");
	}).pipe(Effect.provide(clientLayer({ _tag: "file", filename }))),
);
