import { hasUnsafeInteger } from "./remote-values.ts";
import { Cause, Effect, Exit, Layer, Scope, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient, make } from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { RemoteInspector } from "./remote-inspector.ts";
import { compiler, identify, open } from "./remote-driver.ts";
import {
	type RemoteAttempt,
	type RemoteSession,
	attemptTag,
	failure,
	sanitized,
	sanitizedCause,
} from "./remote-session.ts";

export interface RemoteClientOptions extends RemoteAttempt {
	/** Must durably acknowledge through independent storage/IPC, never this client's pool. */
	readonly register: (session: RemoteSession) => Effect.Effect<void, unknown>;
}
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

const guarded = (options: RemoteClientOptions) =>
	Effect.gen(function* () {
		const tag = yield* attemptTag(options);
		const raw = yield* open(options.connection, tag);
		const acquirer = Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				// SqlClient's transaction acquisition can fail before its own scope finalizer
				// is installed. Own this lease until registration has succeeded.
				const lease = yield* Scope.make();
				const acquired = yield* restore(
					Effect.gen(function* () {
						const connection = yield* Scope.provide(raw.reserve, lease);
						const session = yield* identify(connection, options.connection, tag);
						yield* options.register(session).pipe(Effect.interruptible, Effect.timeout("5 seconds"));
						return safeConnection(connection);
					}),
				).pipe(Effect.exit);
				if (Exit.isFailure(acquired)) {
					yield* Scope.close(lease, acquired);
					return yield* sanitized(Effect.failCause(acquired.cause), "remote_registration_failed");
				}
				yield* Effect.addFinalizer((exit) => Scope.close(lease, exit));
				return acquired.value;
			}),
		);
		// No borrower or raw driver tag escapes. All access paths use this acquirer.
		return yield* make({ acquirer, compiler: compiler(options.connection.engine), spanAttributes: [] });
	});
/** Registration callback is a guardian IPC acknowledgement, not an app-side persistence claim. */
export const guardianClientLayer = (options: RemoteClientOptions) =>
	Layer.effect(SqlClient, guarded(options)).pipe(Layer.provide(Reactivity.layer));

export const remoteClientLayer = (options: RemoteClientOptions) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const inspector = yield* RemoteInspector;
			return guardianClientLayer({
				...options,
				register: (session) => inspector.register(session, options.register(session)),
			});
		}),
	);
