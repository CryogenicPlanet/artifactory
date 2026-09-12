import { Context, Effect, Layer, Option, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Lifecycle } from "./lifecycle.ts";

interface Warning {
	readonly code: "migration.non_portable";
	readonly migration: string;
	readonly extension?: string;
}
const make = Effect.gen(function* () {
	const lifecycle = yield* Lifecycle;
	const state = yield* Ref.make<{ readonly items: ReadonlyArray<Warning>; readonly overflow: number }>({
		items: [],
		overflow: 0,
	});
	return {
		enabled: lifecycle.initial === "rehearsal",
		record: (migration: string, extension?: string) =>
			Ref.update(state, (prior) =>
				prior.items.length === 64
					? { ...prior, overflow: prior.overflow + 1 }
					: {
							...prior,
							items: [
								...prior.items,
								{
									code: "migration.non_portable",
									migration: migration.slice(0, 128),
									...(extension === undefined ? {} : { extension: extension.slice(0, 128) }),
								} satisfies Warning,
							],
						},
			),
		report: Ref.get(state).pipe(Effect.map((value) => (value.items.length ? { warnings: value } : {}))),
	};
});
export class MigrationWarnings extends Context.Service<MigrationWarnings, Effect.Success<typeof make>>()(
	"comms/server/MigrationWarnings",
) {}
export const layer = Layer.effect(MigrationWarnings, make);

export const migrationWarnings = Effect.serviceOption(MigrationWarnings).pipe(
	Effect.map((value) => (Option.isSome(value) && value.value.enabled ? value.value : undefined)),
);

/** Observe only the author's supplied client. A branch is a heuristic, not proof of portability. */
export const observeMigrationDialect = <A, E, R>(
	sql: SqlClient.SqlClient,
	operation: Effect.Effect<A, E, R>,
	unbranched: () => void,
) =>
	Effect.gen(function* () {
		let branched = false;
		const observe = (client: SqlClient.SqlClient): SqlClient.SqlClient => {
			const onDialect: SqlClient.SqlClient["onDialect"] = (options) => {
				branched = true;
				return client.onDialect(options);
			};
			const onDialectOrElse: SqlClient.SqlClient["onDialectOrElse"] = (options) => {
				branched = true;
				return client.onDialectOrElse(options);
			};
			const observed = Object.assign(client.bind(undefined), client, { onDialect, onDialectOrElse });
			// These aliases must retain the same per-migration observation without changing the original client.
			Object.defineProperties(observed, {
				safe: { value: observed },
				withoutTransforms: {
					value: () => {
						const plain = client.withoutTransforms();
						return plain === client ? observed : observe(plain);
					},
				},
			});
			return observed;
		};
		const result = yield* operation.pipe(Effect.provideService(SqlClient.SqlClient, observe(sql)));
		if (!branched) unbranched();
		return result;
	});
