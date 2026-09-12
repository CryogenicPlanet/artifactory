import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_TRANSFER_APP_SIX_PG || !process.env.COMMS_TRANSFER_APP_SIX_MYSQL)(
	"compares all six real frozen app catalogs, ledgers and empty migration intents",
	async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "../fixtures/transfer-app-catalog-six.ts")],
			{ env: process.env },
		);
		const result = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					pairs: Schema.Array(Schema.String),
					verifiedProofs: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, count: Schema.Int })),
				}),
			),
		)(stdout);
		expect(result.pairs).toEqual([
			"sqlite->pg",
			"sqlite->mysql",
			"pg->sqlite",
			"pg->mysql",
			"mysql->sqlite",
			"mysql->pg",
		]);
		// Both exact stored checksums and proof key sets were compared in the fixture.
		expect(result.verifiedProofs.map(({ from, to }) => `${from}->${to}`)).toEqual(result.pairs);
		expect(result.verifiedProofs.every(({ count }) => count > 0)).toBe(true);
	},
	60000,
);
