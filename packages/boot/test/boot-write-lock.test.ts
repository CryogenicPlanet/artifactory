import { Effect, Exit, Result, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { committed } from "../src/auth-primitives.ts";

for (const dialect of ["sqlite", "pg", "mysql"] as const)
	it(`preserves committed refusal and fails closed without the ${dialect} writer lock`, async () => {
		for (const present of [true, false]) {
			const commands: string[] = [];
			const execute = (text: string) =>
				Effect.sync(() => {
					commands.push(text);
					return present && text.includes("FROM seq") ? [{ singleton: 1 }] : [];
				});
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const sql = yield* SqlClient.make({
						acquirer: Effect.succeed({
							execute,
							executeRaw: execute,
							executeUnprepared: execute,
							executeValues: () => Effect.succeed([]),
							executeValuesUnprepared: () => Effect.succeed([]),
							executeStream: () => Stream.empty,
						}),
						compiler: Statement.makeCompiler({
							dialect,
							placeholder: () => "?",
							onIdentifier: (value) => value,
							onRecordUpdate: () => {
								throw new Error("Unused");
							},
							onCustom: () => {
								throw new Error("Unused");
							},
						}),
						spanAttributes: [],
					});
					return yield* committed(sql, sql`SELECT 'proof consumed'`.pipe(Effect.as(Result.fail("refused"))));
				}).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(commands).toEqual([
				"BEGIN",
				...(dialect === "sqlite" ? [] : ["SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE"]),
				...(present || dialect === "sqlite" ? ["SELECT 'proof consumed'", "COMMIT"] : ["ROLLBACK"]),
			]);
		}
	});
