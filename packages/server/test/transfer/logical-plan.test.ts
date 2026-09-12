import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { TransferColumn, TransferInventory, TransferTable } from "@comms/storage/transfer-inventory";
import { logicalTransferPlan } from "../../src/transfer/logical-plan.ts";
import { coreSearchObjects, sqliteEventsDefinition, type TransferEngine } from "../../src/transfer/derived-schema.ts";

const column = (
	name: string,
	kind: TransferColumn["kind"] = "text",
	extra: Partial<TransferColumn> = {},
): TransferColumn => ({
	name,
	kind,
	type: kind,
	declaration: kind,
	nullable: false,
	identity: false,
	generated: false,
	...extra,
});
const table = (name: string, columns: readonly TransferColumn[], primaryKey: readonly string[]): TransferTable => ({
	name,
	columns,
	primaryKey,
	foreignKeys: [],
});
const inventory = (tables: readonly TransferTable[], derived: readonly string[] = []): TransferInventory => ({
	tables,
	derived,
});
const side = (engine: TransferEngine, tables: readonly TransferTable[], app = false) => ({
	engine,
	inventory: inventory(tables, app && engine === "sqlite" ? coreSearchObjects.map((object) => object.name) : []),
});
const rejects = async (effect: ReturnType<typeof logicalTransferPlan>, object: string) => {
	const result = await Effect.runPromise(effect.pipe(Effect.result));
	expect(result).toMatchObject({ _tag: "Failure", failure: { object } });
};

it("projects remote receipt surrogate IDs and hashes onto the same literal SQLite key", async () => {
	const data = [
		column("instance"),
		column("key"),
		column("kind"),
		column("input_hash"),
		column("outcome"),
		column("expires_at", "integer"),
	];
	const sqlite = table("idempotency", data, ["instance", "key"]);
	const mysql = table(
		"idempotency",
		[
			column("row_id", "integer", { identity: true }),
			...data,
			column("key_hash", "text", { generated: true, expression: "sha2(`key`,256)" }),
		],
		["row_id"],
	);
	for (const [source, target] of [
		[side("sqlite", [sqlite], true), side("mysql", [mysql], true)],
		[side("mysql", [mysql], true), side("sqlite", [sqlite], true)],
	]) {
		if (!source || !target) throw Error("Missing side");
		const { tables: plans } = await Effect.runPromise(logicalTransferPlan({ store: "app", source, target }));
		expect(plans[0]?.key).toEqual(["instance", "key"]);
		expect(plans[0]?.columns.map((entry) => entry.name)).toEqual([
			"expires_at",
			"input_hash",
			"instance",
			"key",
			"kind",
			"outcome",
		]);
		expect(plans[0]?.columns.find((entry) => entry.name === "outcome")?.kind).toBe("text");
		expect(plans[0]?.identities).toEqual([]);
	}
});
it("orders allocator and foreign-key parents first and retains meaningful target identities", async () => {
	const seq = table("seq", [column("singleton", "integer"), column("next", "integer")], ["singleton"]);
	const batches = table("batches", [column("id")], ["id"]);
	const versions = {
		...table(
			"versions",
			[column("id", "integer", { identity: true }), column("batch"), column("content", "bytes")],
			["id"],
		),
		foreignKeys: [
			{
				name: "source_fk",
				columns: ["batch"],
				table: "batches",
				targets: ["id"],
				onUpdate: "NO ACTION",
				onDelete: "CASCADE",
			},
		],
	};
	const target = { ...versions, foreignKeys: [{ ...versions.foreignKeys[0]!, name: "different_name" }] };
	const { tables: plans } = await Effect.runPromise(
		logicalTransferPlan({
			store: "boot",
			source: side("sqlite", [versions, batches, seq]),
			target: side("sqlite", [seq, target, batches]),
		}),
	);
	expect(plans.map((plan) => plan.name)).toEqual(["seq", "batches", "versions"]);
	expect(plans[2]?.identities).toEqual(["id"]);
});
it("recognizes only the immutable SQLite generated event definition", async () => {
	const events = {
		...table(
			"events",
			[column("seq", "integer"), column("event"), column("type", "text", { generated: true })],
			["seq"],
		),
		definition: sqliteEventsDefinition,
	};
	const source = side("sqlite", [events]);
	const plan = logicalTransferPlan({ store: "boot", source, target: source });
	expect((await Effect.runPromise(plan)).tables[0]?.columns.map((entry) => entry.name)).toEqual(["event", "seq"]);
	const changed = side("sqlite", [{ ...events, definition: sqliteEventsDefinition.replace("'$.type'", "'$.actor'") }]);
	await rejects(logicalTransferPlan({ store: "boot", source: changed, target: source }), "events.type");
});
it("preserves declared JSON domains without interpreting encoded text images", async () => {
	const values = table("custom", [column("id"), column("domain", "json"), column("previous"), column("event")], ["id"]);
	const { tables: plan } = await Effect.runPromise(
		logicalTransferPlan({
			store: "app",
			source: side("sqlite", [values], true),
			target: side("mysql", [values], true),
		}),
	);
	expect(plan[0]?.columns).toEqual([
		{ name: "domain", kind: "json", nullable: false },
		{ name: "event", kind: "text", nullable: false },
		{ name: "id", kind: "text", nullable: false },
		{ name: "previous", kind: "text", nullable: false },
	]);
	const wrong = {
		...values,
		columns: values.columns.map((entry) => (entry.name === "previous" ? { ...entry, kind: "json" as const } : entry)),
	};
	await rejects(
		logicalTransferPlan({ store: "app", source: side("sqlite", [values], true), target: side("mysql", [wrong], true) }),
		"custom.previous",
	);
});
it("refuses altered known hashes and unknown generated columns", async () => {
	const data = [
		column("id"),
		column("row_id", "integer", { identity: true }),
		column("id_hash", "text", { generated: true, expression: "sha2(`id`,1)" }),
	];
	await rejects(
		logicalTransferPlan({
			store: "boot",
			source: side("mysql", [table("passkeys", data, ["row_id"])]),
			target: side("mysql", [table("passkeys", data, ["row_id"])]),
		}),
		"passkeys.id_hash",
	);
	const extra = table(
		"custom",
		[column("id"), column("derived", "text", { generated: true, expression: "'lost'" })],
		["id"],
	);
	await rejects(
		logicalTransferPlan({ store: "app", source: side("pg", [extra], true), target: side("pg", [extra], true) }),
		"custom.derived",
	);
});
it("accepts only exact trusted SQLite internals and FTS shadow names", async () => {
	const derived = [...coreSearchObjects.map((object) => object.name), "sqlite_schema", "messages_fts_data"];
	const source = { engine: "sqlite" as const, inventory: inventory([], derived) };
	expect(await Effect.runPromise(logicalTransferPlan({ store: "app", source, target: side("pg", [], true) }))).toEqual({
		tables: [],
		ledgers: [],
	});
	await rejects(
		logicalTransferPlan({
			store: "app",
			source: { ...source, inventory: inventory([], [...derived, "messages_fts_custom"]) },
			target: side("pg", [], true),
		}),
		"derived",
	);
});
it("refuses missing tables, keyless tables, cycles and arbitrary derived exclusions", async () => {
	const value = table("value", [column("id")], ["id"]);
	await rejects(
		logicalTransferPlan({ store: "boot", source: side("sqlite", [value]), target: side("sqlite", []) }),
		"tables",
	);
	const keyless = { ...value, primaryKey: [] };
	await rejects(
		logicalTransferPlan({ store: "boot", source: side("sqlite", [keyless]), target: side("sqlite", [keyless]) }),
		"value",
	);
	const cycle = {
		...value,
		foreignKeys: [
			{ name: "cycle", columns: ["id"], table: "value", targets: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" },
		],
	};
	await rejects(
		logicalTransferPlan({ store: "boot", source: side("sqlite", [cycle]), target: side("sqlite", [cycle]) }),
		"foreign_key_cycle",
	);
	await rejects(
		logicalTransferPlan({
			store: "app",
			source: { engine: "sqlite", inventory: inventory([], ["unknown_fts"]) },
			target: side("pg", [], true),
		}),
		"derived",
	);
});

it("accepts the actual migrated SQLite boot event catalog without copying generated projections", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-transfer-plan-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const { stdout } = await promisify(execFile)("bun", [
		join(import.meta.dirname, "../fixtures/transfer-boot-catalog.ts"),
		join(directory, "boot.db"),
	]);
	expect(stdout).toBe("catalog verified");
});

it("separates regenerated ledger timestamps from required migration identity comparison", async () => {
	const source = table(
		"boot_migrations",
		[
			column("migration_id", "integer", { type: "integer" }),
			column("name"),
			column("created_at", "unsupported", { type: "datetime" }),
		],
		["migration_id"],
	);
	const target = {
		...source,
		columns: source.columns.map((entry) =>
			entry.name === "created_at" ? { ...entry, type: "timestamp without time zone" } : entry,
		),
	};
	const plan = await Effect.runPromise(
		logicalTransferPlan({ store: "boot", source: side("sqlite", [source]), target: side("pg", [target]) }),
	);
	expect(plan.tables).toEqual([]);
	expect(plan.ledgers).toEqual([
		{
			name: "boot_migrations",
			columns: [
				{ name: "migration_id", kind: "integer", nullable: false },
				{ name: "name", kind: "text", nullable: false },
			],
			key: ["migration_id"],
			identities: [],
		},
	]);
	const changed = { ...target, columns: [...target.columns, column("unknown_history")] };
	await rejects(
		logicalTransferPlan({ store: "boot", source: side("sqlite", [source]), target: side("pg", [changed]) }),
		"boot_migrations",
	);
});

it("refuses changed foreign-key delete and update behavior despite matching columns", async () => {
	const parent = table("parent", [column("id")], ["id"]);
	const source = {
		...table("child", [column("id"), column("parent")], ["id"]),
		foreignKeys: [
			{
				name: "child_parent",
				columns: ["parent"],
				table: "parent",
				targets: ["id"],
				onDelete: "CASCADE",
				onUpdate: "NO ACTION",
			},
		],
	};
	for (const change of [{ onDelete: "RESTRICT" }, { onUpdate: "CASCADE" }, { onUpdate: "RESTRICT" }]) {
		const target = { ...source, foreignKeys: source.foreignKeys.map((key) => ({ ...key, ...change })) };
		await rejects(
			logicalTransferPlan({
				store: "boot",
				source: side("sqlite", [parent, source]),
				target: side("pg", [parent, target]),
			}),
			"child.foreign_keys",
		);
	}
});

it("refuses SET DEFAULT even when both catalogs name the same action", async () => {
	const parent = table("parent", [column("id")], ["id"]);
	const child = {
		...table("child", [column("id"), column("parent")], ["id"]),
		foreignKeys: [
			{
				name: "fk",
				columns: ["parent"],
				table: "parent",
				targets: ["id"],
				onDelete: "SET DEFAULT",
				onUpdate: "NO ACTION",
			},
		],
	};
	await rejects(
		logicalTransferPlan({
			store: "boot",
			source: side("sqlite", [parent, child]),
			target: side("pg", [parent, child]),
		}),
		"child.foreign_keys",
	);
});
