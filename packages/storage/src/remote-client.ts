import { hasUnsafeInteger } from "./remote-values.ts";
import { Cause, Effect, Layer, Ref, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient, make } from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { compiler, open, connectionFailure } from "./remote-driver.ts";
import { type RemoteConnection, failure, sanitized, sanitizedCause } from "./remote-session.ts";

const checked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	sanitized(
		effect.pipe(
			Effect.flatMap((value) =>
				hasUnsafeInteger(value) ? Effect.fail(failure("remote_query_failed")) : Effect.succeed(value),
			),
		),
		"remote_query_failed",
	);

const safeConnection = (connection: Connection): Connection => ({
	execute: (...args) => checked(connection.execute(...args)),
	executeRaw: (...args) => checked(connection.executeRaw(...args)),
	executeValues: (...args) => checked(connection.executeValues(...args)),
	executeValuesUnprepared: (...args) => checked(connection.executeValuesUnprepared(...args)),
	executeUnprepared: (...args) => checked(connection.executeUnprepared(...args)),
	executeStream: (...args) =>
		connection.executeStream(...args).pipe(
			Stream.mapEffect((value) => checked(Effect.succeed(value))),
			Stream.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Stream.fromEffect(Effect.interrupt)
					: Stream.fail(sanitizedCause(cause, "remote_query_failed")),
			),
		),
});

/** One physical session owns all queries and transactions until this layer closes. */
const pinnedClient = (connection: RemoteConnection, writing: boolean) =>
	Effect.gen(function* () {
		const raw = yield* open(connection, "chirp");
		const pinned = yield* connectionFailure(raw.reserve, connection);
		if (connection.engine === "mysql") {
			const rows = yield* sanitized(
				pinned.executeValues("SELECT @@SESSION.transaction_isolation", []),
				"remote_connection_failed",
			);
			if (rows.length !== 1 || rows[0]?.[0] !== "REPEATABLE-READ")
				return yield* failure("remote_isolation_unsupported");
		}
		if (writing) {
			const rows = yield* sanitized(
				pinned.executeValues(
					connection.engine === "pg"
						? "SELECT pg_try_advisory_lock(1128813138, 1)"
						: "SELECT GET_LOCK(CONCAT('chirp:', SHA2(DATABASE(), 224)), 0)",
					[],
				),
				"remote_connection_failed",
			);
			if (rows.length !== 1 || (rows[0]?.[0] !== true && rows[0]?.[0] !== 1))
				return yield* failure("remote_writer_busy");
		}
		const permit = yield* Semaphore.make(1);
		const invalid = yield* Ref.make(false);
		const safe = safeConnection(pinned);
		// Mutation writes must stay inside sql.withTransaction: only failed transaction-control
		// statements latch this session invalid; a failing bare statement does not.
		const selected: Connection = {
			...safe,
			executeUnprepared: (sql, ...args) =>
				safe
					.executeUnprepared(sql, ...args)
					.pipe(
						Effect.onError(() =>
							/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql) ? Ref.set(invalid, true) : Effect.void,
						),
					),
		};
		const acquirer = Effect.acquireRelease(
			Effect.gen(function* () {
				yield* permit.take(1);
				return yield* Effect.gen(function* () {
					if (yield* Ref.get(invalid)) return yield* failure("remote_connection_failed");
					return selected;
				}).pipe(Effect.onError(() => permit.release(1)));
			}),
			() => permit.release(1),
		);

		return yield* make({ acquirer, compiler: compiler(connection.engine), spanAttributes: [] });
	});

/** Session advisory ownership is cooperative; unrelated SQL connections are not fenced. */
export const advisoryClientLayer = (options: { readonly connection: RemoteConnection }) =>
	Layer.effect(SqlClient, pinnedClient(options.connection, true)).pipe(Layer.provide(Reactivity.layer));

/** Scoped inspection client. Callers must use advisoryClientLayer for exclusive writes. */
export const directClientLayer = (options: { readonly connection: RemoteConnection }) =>
	Layer.effect(SqlClient, pinnedClient(options.connection, false)).pipe(Layer.provide(Reactivity.layer));
