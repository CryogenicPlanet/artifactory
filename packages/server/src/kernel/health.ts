import { Cause, Crypto, Effect, Ref, Schema, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { HealthProbe, layer as probeLayer, rehearsalLayer } from "./health-probe.ts";
import { Publication } from "./publication.ts";

class RolledBack extends Schema.TaggedError<RolledBack>()("HealthRolledBack", {}) {}

/** Exercise kernel mutation and publication-aware reads, then confirm rollback before aborting. */
export const probeHealth = <E = never, R = never>(
	before: Effect.Effect<void, E, R | Scope.Scope> = Effect.void,
	privateRehearsal = false,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const boot = yield* BootChannel;
		const probe = yield* HealthProbe;
		const publication = yield* Publication;
		const marker = Buffer.from(yield* (yield* Crypto.Crypto).randomBytes(16)).toString("hex");
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* before;
					yield* publication.recordEvent(
						{ transaction: marker, type: "kernel.health", level: "info", payload: {} },
						(seq) =>
							sql`INSERT INTO kv(ns,key,value,updated_seq,previous) VALUES('kernel-health',${marker},${marker},${seq},NULL)`.pipe(
								Effect.asVoid,
							),
					);
					const rows = yield* publication.read(
						(fence) => sql`SELECT value FROM kv WHERE ns='kernel-health' AND key=${marker} AND updated_seq<=${fence}`,
					);
					if (rows.length !== 1 || rows[0]?.value !== marker)
						return yield* new KernelError({ code: "health_read_invalid" });
					return yield* new RolledBack();
				}),
			)
			.pipe(Effect.exit);
		// Effect.result would discard a rollback defect accompanying a typed failure. Never resolve that uncertainty.
		if (result._tag === "Success") return yield* new KernelError({ code: "health_failed" });
		if (result.cause.reasons.length === 0 || !result.cause.reasons.every(Cause.isFailReason))
			return yield* Effect.failCause(result.cause);
		for (const reservation of yield* Ref.get(probe.reservations)) {
			yield* boot.reserve(reservation.transaction, reservation.count);
			yield* boot.abort(reservation.transaction);
		}
		if (!result.cause.reasons.some((reason) => Cause.isFailReason(reason) && Schema.is(RolledBack)(reason.error)))
			return yield* new KernelError({ code: "health_failed" });
		return { status: "ok" };
	}).pipe(Effect.provide(privateRehearsal ? rehearsalLayer : probeLayer));
