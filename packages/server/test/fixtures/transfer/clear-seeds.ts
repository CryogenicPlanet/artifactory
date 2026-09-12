import { clientLayer } from "@comms/storage/client";
import { selectionText, type TransferSelection } from "@comms/storage/store-transfer-schema";
import type { TransferTablePlan } from "@comms/storage/transfer-copy";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clearTransferSeeds } from "../../../src/transfer/clear-seeds.ts";

const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw new Error("Missing fixture root");
await Effect.runPromise(
	Effect.gen(function* () {
		const open = (name: string) =>
			Layer.build(clientLayer({ _tag: "file", filename: `${root}/${name}.db` })).pipe(
				Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
			);
		const boot = yield* open("boot");
		const app = yield* open("app");
		const selection: TransferSelection = {
			version: 1,
			transfer_id: "12345678-1234-4123-8123-123456789abc",
			store_id: "98765432-1234-4123-8123-123456789abc",
			data_directory: root,
			source: { engine: "sqlite", endpoint: null, boot: `${root}/source-boot.db`, app: `${root}/source-app.db` },
			target: { engine: "sqlite", endpoint: null, boot: `${root}/boot.db`, app: `${root}/app.db` },
		};
		yield* boot`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
		yield* boot`INSERT INTO settings VALUES('transfer_prepare',${selectionText(selection)}),('transfer_state','in_progress')`;
		yield* app`PRAGMA foreign_keys=ON`;
		yield* app`CREATE TABLE parent(id INTEGER PRIMARY KEY)`;
		yield* app`CREATE TABLE child(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL REFERENCES parent(id))`;
		yield* app`INSERT INTO parent VALUES(1)`;
		yield* app`INSERT INTO child VALUES(2,1)`;
		for (const name of [
			"store_identity",
			"kernel_writer",
			"outbox",
			"mutation_batches",
			"core_migrations",
			"migrations",
			"extension_migrations",
		]) {
			yield* app`CREATE TABLE ${app(name)}(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`;
			yield* app`INSERT INTO ${app(name)} VALUES(1,${`retained ${name}`})`;
		}
		const table = (name: string): TransferTablePlan => ({
			name,
			columns: [{ name: "id", kind: "integer", nullable: false }],
			key: ["id"],
			identities: [],
		});
		const names = ["store_identity", "kernel_writer", "outbox", "mutation_batches", "parent", "child"];
		if (mode === "journal") yield* boot`INSERT INTO settings VALUES('transfer_journal','{}')`;
		if (mode === "retired") yield* boot`INSERT INTO settings VALUES('transferred_to','retired')`;
		if (mode === "complete") yield* boot`UPDATE settings SET value='complete' WHERE key='transfer_state'`;
		if (mode === "mismatch")
			yield* boot`UPDATE settings SET value='unrelated preparation' WHERE key='transfer_prepare'`;
		if (mode === "missing-core") names.splice(0, 1);
		if (mode === "ledger-plan") names.push("migrations");
		if (mode === "rollback") names.splice(names.indexOf("parent"), 0, "missing_table");
		const result = yield* Effect.gen(function* () {
			yield* clearTransferSeeds(boot, app, selection, { store: "app", tables: names.map(table) });
			yield* clearTransferSeeds(boot, app, selection, { store: "app", tables: names.map(table) });
		}).pipe(Effect.result);
		const parent = yield* app`SELECT * FROM parent`;
		const child = yield* app`SELECT * FROM child`;
		const retained: string[] = [];
		for (const name of [
			"store_identity",
			"kernel_writer",
			"outbox",
			"mutation_batches",
			"core_migrations",
			"migrations",
			"extension_migrations",
		]) {
			const rows = yield* app<{ value: string }>`SELECT value FROM ${app(name)}`;
			if (rows[0]) retained.push(rows[0].value);
		}
		console.log(JSON.stringify({ result, parent, child, retained }));
	}).pipe(Effect.scoped),
);
