import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { validateTransferBinding } from "../src/store-transfer-schema.ts";
import type { TransferBinding } from "../src/store-transfer-schema.ts";

it.for(["transfer_id", "store_id", "manifest"] as const)("refuses a final newline in transfer %s", async (field) => {
	const binding: TransferBinding = {
		version: 1,
		transfer_id: "22222222-2222-4222-8222-222222222222",
		store_id: "11111111-1111-4111-8111-111111111111",
		manifest: "a".repeat(64),
		data_directory: "/data",
		source: { engine: "sqlite", endpoint: null, boot: "/data/boot.db", app: "/data/store/comms.db" },
		target: { engine: "pg", endpoint: "localhost:5432", boot: "boot", app: "app" },
	};
	expect(await Effect.runPromise(validateTransferBinding(binding))).toEqual(binding);
	const result = await Effect.runPromiseExit(validateTransferBinding({ ...binding, [field]: `${binding[field]}\n` }));
	expect(Exit.isFailure(result)).toBe(true);
});
