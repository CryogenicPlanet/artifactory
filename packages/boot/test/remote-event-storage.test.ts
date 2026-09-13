import { Effect, FileSystem } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { makeEventStorage } from "../src/event-storage.ts";

it.for(["pg", "mysql"] as const)(
	"%s reports unknown capacity without querying SQLite or the local volume",
	async (dialect) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.make({
					acquirer: Effect.die("Remote accounting must not query or reserve a connection"),
					compiler: Statement.makeCompiler({
						dialect,
						placeholder: () => "?",
						onIdentifier: (value) => value,
						onRecordUpdate: () => {
							throw new Error("No statements expected");
						},
						onCustom: () => {
							throw new Error("No statements expected");
						},
					}),
					spanAttributes: [],
				});
				const storage = yield* makeEventStorage(Effect.die("Local volume cannot measure remote capacity")).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
				);
				yield* storage.prune;
				yield* storage.admit;
				return yield* storage.status;
			}).pipe(Effect.provide(Reactivity.layer)),
		);
		expect(result).toEqual({ status: "unknown", reason: "remote_capacity_unavailable" });
	},
);
