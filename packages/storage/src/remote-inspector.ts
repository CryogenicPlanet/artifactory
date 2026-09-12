import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { accountSessions, assertNoPreparedXa, connectionIds, identify, open, sessions } from "./remote-driver.ts";
import {
	type RemoteConnection,
	type RemoteAttempt,
	type RemoteSession,
	attemptTag,
	failure,
	sanitized,
} from "./remote-session.ts";

export interface RemoteInspection {
	readonly server: RemoteSession;
	readonly register: (session: RemoteSession, persist: Effect.Effect<void, unknown>) => Effect.Effect<void, SqlError>;
	/** Closes registration admission, then requires positive caller-local writer closure.
	 * An inspector must predate the attempt; a fresh inspector cannot recover old closure proof. */
	readonly assertAccountClosed: (afterLocalClosure: Effect.Effect<void, unknown>) => Effect.Effect<void, SqlError>;
	readonly assertNoSessions: (afterLocalClosure: Effect.Effect<void, unknown>) => Effect.Effect<void, SqlError>;
}
export class RemoteInspector extends Context.Service<RemoteInspector, RemoteInspection>()(
	"comms/storage/RemoteInspector",
) {}

export interface RemoteInspectorOptions extends RemoteAttempt {
	/** Only immutable root owners may span databases on their one exact account. */
	readonly scope?: "database" | "account";
	readonly mysqlBootConnection?: RemoteConnection;
}

const inspect = (options: RemoteInspectorOptions) =>
	Effect.gen(function* () {
		const tag = yield* attemptTag(options);
		const inspectorTag = `inspect:${tag.slice(6)}`;
		const raw = yield* open(options.connection, inspectorTag);
		// One pinned physical connection for the entire inspector lifetime. A server
		// restart breaks it; no pooled reacquisition can turn a new empty server into proof.
		const connection = yield* raw.reserve;
		const server = yield* identify(connection, options.connection, inspectorTag);
		const privileged = options.mysqlBootConnection;
		if (
			privileged &&
			(options.connection.engine !== "mysql" ||
				privileged.engine !== "mysql" ||
				privileged.host !== options.connection.host ||
				privileged.port !== options.connection.port ||
				privileged.tls !== options.connection.tls)
		)
			return yield* failure("remote_configuration_invalid");
		const xa = privileged
			? yield* Effect.gen(function* () {
					const tag = `xa:${options.attempt.slice(0, 48)}`;
					const pool = yield* open(privileged, tag);
					const connection = yield* pool.reserve;
					const identity = yield* identify(connection, privileged, tag);
					if (identity.server !== server.server) return yield* failure("remote_inspection_failed");
					// Prove privilege before any app SQL becomes eligible.
					yield* assertNoPreparedXa(connection);
					return { connection, identity, tag, options: privileged };
				})
			: null;
		const closing = yield* Ref.make(false);
		const registered = yield* Ref.make<ReadonlySet<string>>(new Set());
		const admission = yield* Semaphore.make(1);
		const inspection = yield* Semaphore.make(1);
		const accountClosed = (afterLocalClosure: Effect.Effect<void, unknown>) =>
			inspection.withPermit(
				sanitized(
					Effect.gen(function* () {
						yield* admission.withPermit(Ref.set(closing, true));
						yield* sanitized(afterLocalClosure, "remote_local_closure_unproven");
						const before = yield* identify(connection, options.connection, inspectorTag);
						if (before.server !== server.server || before.connectionId !== server.connectionId)
							return yield* failure("remote_inspection_failed");
						if (options.connection.engine === "mysql" && !xa) return yield* failure("remote_inspection_failed");
						const allowed = new Set([
							server.connectionId,
							...(xa?.identity.username === server.username ? [xa.identity.connectionId] : []),
						]);
						const ids = yield* accountSessions(connection, options.connection);
						if (!ids.some(([id]) => id === server.connectionId)) return yield* failure("remote_inspection_failed");
						if (ids.some(([id]) => !allowed.has(id))) return yield* failure("remote_sessions_open");
						if (xa) {
							const prior = yield* identify(xa.connection, xa.options, xa.tag);
							if (prior.server !== xa.identity.server || prior.connectionId !== xa.identity.connectionId)
								return yield* failure("remote_inspection_failed");
							yield* assertNoPreparedXa(xa.connection);
							const afterXa = yield* identify(xa.connection, xa.options, xa.tag);
							if (afterXa.server !== xa.identity.server || afterXa.connectionId !== xa.identity.connectionId)
								return yield* failure("remote_inspection_failed");
						}
						const after = yield* identify(connection, options.connection, inspectorTag);
						if (after.server !== server.server || after.connectionId !== server.connectionId)
							return yield* failure("remote_inspection_failed");
					}),
					"remote_inspection_failed",
				),
			);
		return {
			assertAccountClosed: accountClosed,
			server,
			register: (session: RemoteSession, persist: Effect.Effect<void, unknown>) =>
				admission.withPermit(
					sanitized(
						Effect.gen(function* () {
							if (
								(yield* Ref.get(closing)) ||
								session.tag !== tag ||
								session.engine !== server.engine ||
								session.server !== server.server ||
								!session.database ||
								(options.scope !== "account" && session.database !== server.database) ||
								session.username !== server.username
							)
								return yield* failure("remote_registration_failed");
							const current = yield* identify(connection, options.connection, inspectorTag);
							if (current.server !== server.server || current.connectionId !== server.connectionId)
								return yield* failure("remote_inspection_failed");
							// Track before the acknowledgement: failures may leave an idle pool session.
							yield* Ref.update(registered, (ids) => new Set([...ids, session.connectionId]));
							yield* persist;
						}),
						"remote_registration_failed",
					),
				),
			assertNoSessions: (afterLocalClosure: Effect.Effect<void, unknown>) =>
				inspection.withPermit(
					sanitized(
						Effect.gen(function* () {
							yield* admission.withPermit(Ref.set(closing, true));
							yield* sanitized(afterLocalClosure, "remote_local_closure_unproven");
							const before = yield* identify(connection, options.connection, inspectorTag);
							if (
								before.server !== server.server ||
								before.connectionId !== server.connectionId ||
								before.username !== server.username
							)
								return yield* failure("remote_inspection_failed");
							if ((yield* sessions(connection, options.connection.engine, tag)).length !== 0)
								return yield* failure("remote_sessions_open");
							const ids = yield* Ref.get(registered);
							if ((yield* connectionIds(connection, options.connection.engine)).some(([id]) => ids.has(id)))
								return yield* failure("remote_sessions_open");
							// Prove the same inspector still exists after observation as well.
							const after = yield* identify(connection, options.connection, inspectorTag);
							if (after.server !== server.server || after.connectionId !== server.connectionId)
								return yield* failure("remote_inspection_failed");
						}),
						"remote_inspection_failed",
					),
				),
		} satisfies RemoteInspection;
	});
export const remoteInspectorLayer = (options: RemoteInspectorOptions) =>
	Layer.effect(RemoteInspector, inspect(options)).pipe(Layer.provide(Reactivity.layer));

/** Production owner proof: missing privileged MySQL visibility refuses before any app lease. */
export const remoteOwnerInspectorLayer = (options: RemoteInspectorOptions) =>
	Layer.effect(
		RemoteInspector,
		Effect.gen(function* () {
			if (options.connection.engine === "mysql" && !options.mysqlBootConnection)
				return yield* failure("remote_configuration_invalid");
			return yield* inspect(options);
		}),
	).pipe(Layer.provide(Reactivity.layer));
