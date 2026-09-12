import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { portablePublicationStore } from "./portable-publication-store.ts";
import { portableOutboxCase } from "./portable-outbox-cases.ts";

async function main() {
	const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(
		process.env.COMMS_TEST_ENGINE,
	);
	const mode = Schema.decodeUnknownSync(Schema.Literals(["pending", "incomplete", "bounded"]))(process.argv[2]);
	const directory = process.env.COMMS_OUTBOX_CONFIG_DIR;
	let phase = "schema";
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { sql, channel } = yield* portablePublicationStore({
					engine,
					appConfig: directory ? `${directory}/${engine}-outbox-${mode}-app.json` : undefined,
					bootConfig: directory ? `${directory}/${engine}-outbox-${mode}-boot.json` : undefined,
					appDatabase: `comms_outbox_${mode}_app`,
					bootDatabase: `comms_outbox_${mode}_boot`,
				});
				phase = mode;
				yield* portableOutboxCase(sql, channel, mode);
			}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(Reactivity.layer)),
		);
		process.stdout.write(`PORTABLE_OUTBOX_${mode}_VERIFIED\n`);
	} catch {
		throw new Error(`Portable outbox fixture failed during ${phase}`);
	}
}
await main();
