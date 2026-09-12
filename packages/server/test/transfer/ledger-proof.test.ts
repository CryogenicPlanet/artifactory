import { Effect, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { ledgerProof } from "../../src/transfer/ledger-proof.ts";

type Rows = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
const client = (tables: Rows) =>
	SqlClient.make({
		acquirer: Effect.succeed({
			execute: (query: string) =>
				Effect.sync(() => {
					const table = Object.keys(tables).find((name) => query.endsWith(`FROM ${name}`));
					if (!table) throw new Error(`Unexpected query: ${query}`);
					return tables[table] ?? [];
				}),
			executeRaw: () => Effect.die("Unexpected raw query"),
			executeUnprepared: () => Effect.die("Unexpected unprepared query"),
			executeValues: () => Effect.die("Unexpected values query"),
			executeValuesUnprepared: () => Effect.die("Unexpected values query"),
			executeStream: () => Stream.empty,
		}),
		compiler: Statement.makeCompiler({
			dialect: "sqlite",
			placeholder: () => "?",
			onIdentifier: (name) => name,
			onRecordUpdate: () => {
				throw new Error("Unexpected update");
			},
			onCustom: () => {
				throw new Error("Unexpected custom");
			},
		}),
		spanAttributes: [],
	});
const check = (
	source: Rows,
	target: Rows,
	extensions: Parameters<typeof ledgerProof>[0]["extensions"] = [],
	names = Object.keys(source),
	store: "boot" | "app" = "app",
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* ledgerProof({
				source: yield* client(source),
				target: yield* client(target),
				ledgers: names.map((name) => ({ name })),
				extensions,
				store,
			}).pipe(Effect.result);
		}).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
	);
const core = [{ migration_id: 1, name: "core" }] as const;
const empty = { core_migrations: core, migrations: [] } as const;
it("compares exact IDs and names in canonical order, excluding timestamps", async () => {
	const source = {
		boot_migrations: [
			{ migration_id: 3, name: "三", created_at: "old" },
			{ migration_id: 1, name: "first" },
		],
	};
	const target = {
		boot_migrations: [
			{ migration_id: 1, name: "first" },
			{ migration_id: 3, name: "三", created_at: "new" },
		],
	};
	expect(await check(source, target, [], ["boot_migrations"], "boot")).toMatchObject({
		_tag: "Success",
		success: [
			{
				name: "boot_migrations",
				rows: [
					{ migration_id: 1, name: "first" },
					{ migration_id: 3, name: "三" },
				],
			},
		],
	});
});
it("refuses missing, extra, renamed, duplicate and unsafe migration IDs", async () => {
	for (const rows of [
		[],
		[...core, { migration_id: 2, name: "extra" }],
		[{ migration_id: 1, name: "changed" }],
		[...core, ...core],
		[{ migration_id: Number.MAX_SAFE_INTEGER + 1, name: "bad" }],
	])
		expect((await check(empty, { ...empty, core_migrations: rows }))._tag).toBe("Failure");
});
it("permits absent extension ledgers only with no declarations and requires standard ledgers", async () => {
	expect((await check(empty, empty))._tag).toBe("Success");
	for (const names of [
		["migrations"],
		["core_migrations", "migrations", "other"],
		["core_migrations", "migrations", "migrations"],
	])
		expect((await check(empty, empty, [], names))._tag).toBe("Failure");
});
it("uses frozen extension proofs for distinct dialect checksums and refuses changed or missing evidence", async () => {
	const proof = {
		extension: "sample",
		name: "initial",
		sourceChecksum: "a".repeat(64),
		targetChecksum: "b".repeat(64),
	};
	const source = {
		...empty,
		extension_migrations: [{ extension: proof.extension, name: proof.name, checksum: proof.sourceChecksum }],
	};
	const target = {
		...empty,
		extension_migrations: [{ extension: proof.extension, name: proof.name, checksum: proof.targetChecksum }],
	};
	expect(await check(source, target, [proof])).toMatchObject({
		_tag: "Success",
		success: expect.arrayContaining([{ name: "extension_migrations", rows: [proof] }]),
	});
	expect((await check(source, target))._tag).toBe("Failure");
	expect((await check(source, target, [{ ...proof, sourceChecksum: "c".repeat(64) }]))._tag).toBe("Failure");
	expect((await check(empty, empty, [proof]))._tag).toBe("Failure");
});
