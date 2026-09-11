import { Context, Crypto, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

export const Lock = Schema.Struct({
	id: Schema.String,
	holder_family: Schema.String,
	agent: Schema.String,
	since: Schema.Int,
	expires: Schema.Int,
	ttl_seconds: Schema.Int,
	note: Schema.String,
	cutover_in_flight: Schema.Literals([0, 1]),
	pending_release: Schema.NullOr(Schema.Literals(["broken", "revoked"])),
});
export type Lock = typeof Lock.Type;
const Transition = Schema.Struct({
	type: Schema.Literals([
		"acquired",
		"renewed",
		"staged",
		"released",
		"expired",
		"broken",
		"revoked",
		"pinned",
		"finished",
		"interrupted",
	]),
	lock_id: Schema.String,
	holder_family: Schema.String,
	agent: Schema.String,
	staged: Schema.Array(Schema.String),
	deferred: Schema.Boolean,
});
export type Transition = typeof Transition.Type;
export class EditRejected extends Schema.TaggedError<EditRejected>()("EditRejected", {
	code: Schema.Literals([
		"authority_expired",
		"lock_required",
		"locked",
		"stale_lock",
		"cutover_in_flight",
		"invalid_ttl",
		"invalid_path",
		"not_pinned",
		"staging_not_empty",
	]),
	holder: Schema.NullOr(Lock),
	transitions: Schema.Array(Transition),
}) {
	get message() {
		return `Edit operation rejected: ${this.code}`;
	}
}
/** Supplied only by authenticated edit HTTP mutations; checked under the lock's SQL admission transaction. */
export class EditAuthority extends Context.Service<
	EditAuthority,
	{ readonly kind: "human" | "agent"; readonly id: string; readonly expiresAt: number }
>()("comms/boot/EditAuthority") {}
export const authorityLayer = (authority: EditAuthority["Service"]) => Layer.succeed(EditAuthority, authority);

export interface Ownership {
	readonly id: string;
	readonly family: string;
}
export interface Outcome<A> {
	readonly value: A;
	readonly transitions: readonly Transition[];
}
export const StagedFile = Schema.Struct({
	path: Schema.String,
	content: Schema.NullOr(Schema.Uint8Array),
	sha: Schema.NullOr(Schema.String),
	at: Schema.Int,
	mode: Schema.NullOr(Schema.Int),
});

// SQL paths are canonical names, not filesystem resolution. Publication must separately reject symlinks.
const validPath = (path: string) => {
	const parts = path.split("/");
	return (
		parts[0] === "app" &&
		parts.length > 1 &&
		!/[\\:]/.test(path) &&
		Array.from(path).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
		parts.every(
			(part) => part !== "" && part !== "." && part !== ".." && part !== "node_modules" && part !== ".vite",
		) &&
		!(parts[1] === "ui" && parts[2] === "dist")
	);
};

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const read = sql`SELECT * FROM edit_lock WHERE singleton = 1`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Lock))),
		Effect.map((rows) => rows[0] ?? null),
	);
	const files = (id: string) =>
		sql`SELECT path, content, sha, at, mode FROM staging WHERE lock_id = ${id} ORDER BY path`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StagedFile))),
		);
	const drop = Effect.fn("EditLock.drop")(function* (lock: Lock, type: Transition["type"]) {
		const staged = yield* sql`SELECT path FROM staging WHERE lock_id = ${lock.id} ORDER BY path`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
			Effect.map((rows) => rows.map((row) => row.path)),
		);
		yield* sql`DELETE FROM staging WHERE lock_id = ${lock.id}`;
		yield* sql`DELETE FROM edit_lock WHERE id = ${lock.id}`;
		return {
			type,
			lock_id: lock.id,
			holder_family: lock.holder_family,
			agent: lock.agent,
			staged,
			deferred: false,
		} satisfies Transition;
	});
	const reject = (code: EditRejected["code"], holder: Lock | null, transitions: readonly Transition[]) =>
		new EditRejected({ code, holder, transitions });
	const ownerError = (lock: Lock | null, owner: Ownership, transitions: readonly Transition[]) =>
		!lock
			? reject("lock_required", lock, transitions)
			: lock.holder_family !== owner.family
				? reject("locked", lock, transitions)
				: lock.id !== owner.id
					? reject("stale_lock", lock, transitions)
					: null;
	// Domain rejection is a value until COMMIT, so expiry cleanup cannot be rolled back by a refused request.
	const admit = <A>(
		action: (
			lock: Lock | null,
			now: number,
			transitions: Transition[],
		) => Effect.Effect<Outcome<A> | EditRejected, SqlError | Schema.SchemaError>,
		checkAuthority = true,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					let lock = yield* read;
					const now = (yield* DateTime.nowAsDate).getTime();
					const transitions: Transition[] = [];
					const authority = checkAuthority ? Option.getOrNull(yield* Effect.serviceOption(EditAuthority)) : null;
					if (authority) {
						const active =
							authority.kind === "human"
								? yield* sql`SELECT id FROM sessions WHERE id=${authority.id} AND expires_at>${now}`
								: yield* sql`SELECT id FROM tokens WHERE family=${authority.id} AND kind='access' AND revoked_at IS NULL LIMIT 1`;
						if (authority.expiresAt <= now || active.length === 0)
							return reject("authority_expired", lock, transitions);
					}
					if (lock && !lock.cutover_in_flight && lock.expires <= now) {
						transitions.push(yield* drop(lock, "expired"));
						lock = null;
					}
					return yield* action(lock, now, transitions);
				}),
			)
			.pipe(
				Effect.map((result) => (Schema.is(EditRejected)(result) ? Result.fail(result) : Result.succeed(result))),
				Effect.flatMap(Effect.fromResult),
			);
	const renew = (lock: Lock, now: number) =>
		sql`UPDATE edit_lock SET expires = ${now + lock.ttl_seconds * 1000} WHERE id = ${lock.id}`;
	const stageBatch = Effect.fn("EditLock.stageBatch")(function* (
		owner: Ownership,
		writes: readonly { readonly path: string; readonly content: Uint8Array | null; readonly mode?: number | null }[],
		options: { readonly requireEmpty?: boolean } = {},
	) {
		const staged: Array<Omit<typeof StagedFile.Type, "at">> = [];
		for (const write of writes) {
			const content = write.content?.slice() ?? null;
			const sha = content === null ? null : Buffer.from(yield* crypto.digest("SHA-256", content)).toString("hex");
			staged.push({ path: write.path, content, sha, mode: content === null ? null : (write.mode ?? null) });
		}
		return yield* admit<Lock>((lock, now, transitions) =>
			Effect.gen(function* () {
				const error = ownerError(lock, owner, transitions);
				if (error || !lock) return error ?? reject("lock_required", lock, transitions);
				if (lock.cutover_in_flight) return reject("cutover_in_flight", lock, transitions);
				if (options.requireEmpty && (yield* files(lock.id)).length > 0)
					return reject("staging_not_empty", lock, transitions);
				for (const file of staged)
					if (
						!validPath(file.path) ||
						(file.mode !== null && (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777))
					)
						return reject("invalid_path", lock, transitions);
				for (const file of staged)
					yield* sql`INSERT INTO staging (lock_id,path,content,sha,at,mode) VALUES (${lock.id},${file.path},${file.content},${file.sha},${now},${file.mode}) ON CONFLICT(lock_id,path) DO UPDATE SET content=excluded.content,sha=excluded.sha,at=excluded.at,mode=excluded.mode`;
				yield* renew(lock, now);
				transitions.push({
					type: "staged",
					lock_id: lock.id,
					holder_family: lock.holder_family,
					agent: lock.agent,
					staged: staged.map((file) => file.path),
					deferred: false,
				});
				return { value: { ...lock, expires: now + lock.ttl_seconds * 1000 }, transitions };
			}),
		);
	});

	return {
		inspect: admit((lock, _now, transitions) => Effect.succeed({ value: lock, transitions }), false),
		acquire: Effect.fn("EditLock.acquire")(function* (
			family: string,
			agent: string,
			options: { readonly ttl?: number; readonly note?: string } = {},
		) {
			const id = yield* crypto.randomUUIDv4;
			return yield* admit<Lock>((lock, now, transitions) =>
				Effect.gen(function* () {
					if (options.ttl !== undefined && (!Number.isSafeInteger(options.ttl) || options.ttl <= 0))
						return reject("invalid_ttl", lock, transitions);
					if (lock?.cutover_in_flight) return reject("cutover_in_flight", lock, transitions);
					if (lock && lock.holder_family !== family) return reject("locked", lock, transitions);
					const value: Lock = {
						id: lock?.id ?? id,
						holder_family: family,
						agent: lock?.agent ?? agent,
						since: lock?.since ?? now,
						ttl_seconds: Math.min(options.ttl ?? lock?.ttl_seconds ?? 900, 3600),
						expires: now + Math.min(options.ttl ?? lock?.ttl_seconds ?? 900, 3600) * 1000,
						note: options.note ?? lock?.note ?? "",
						cutover_in_flight: 0,
						pending_release: null,
					};
					yield* sql`INSERT OR REPLACE INTO edit_lock ${sql.insert({ singleton: 1, ...value })}`;
					transitions.push({
						type: lock ? "renewed" : "acquired",
						lock_id: value.id,
						holder_family: value.holder_family,
						agent: value.agent,
						staged: [],
						deferred: false,
					});
					return { value, transitions };
				}),
			);
		}),
		stage: (owner: Ownership, path: string, content: Uint8Array | null, mode: number | null = null) =>
			stageBatch(owner, [{ path, content, mode }]),
		stageBatch,

		overlay: (owner: Ownership) =>
			admit((lock, _now, transitions) =>
				Effect.gen(function* () {
					const error = ownerError(lock, owner, transitions);
					if (error) return error;
					return { value: yield* files(owner.id), transitions };
				}),
			),
		release: (owner: Ownership) =>
			admit<null>((lock, _now, transitions) =>
				Effect.gen(function* () {
					const error = ownerError(lock, owner, transitions);
					if (error || !lock) return error ?? reject("lock_required", lock, transitions);
					if (lock.cutover_in_flight) return reject("cutover_in_flight", lock, transitions);
					transitions.push(yield* drop(lock, "released"));
					return { value: null, transitions };
				}),
			),
		// Trusted caller only: authentication/assertion verification belongs before these store operations.
		breakLock: (id: string) => releaseTrusted("broken", undefined, id),
		revokeFamily: (family: string) => releaseTrusted("revoked", family),
		pin: (owner: Ownership) =>
			admit<Lock>((lock, _now, transitions) =>
				Effect.gen(function* () {
					const error = ownerError(lock, owner, transitions);
					if (error || !lock) return error ?? reject("lock_required", lock, transitions);
					if (lock.cutover_in_flight) return reject("cutover_in_flight", lock, transitions);
					yield* sql`UPDATE edit_lock SET cutover_in_flight = 1 WHERE id = ${lock.id}`;
					transitions.push({
						type: "pinned",
						lock_id: lock.id,
						holder_family: lock.holder_family,
						agent: lock.agent,
						staged: [],
						deferred: false,
					});
					return { value: { ...lock, cutover_in_flight: 1 }, transitions };
				}),
			),
		finish: (owner: Ownership, options: { readonly succeeded: boolean; readonly release?: boolean }) =>
			admit<Lock | null>(
				(lock, now, transitions) =>
					Effect.gen(function* () {
						const error = ownerError(lock, owner, transitions);
						if (error || !lock) return error ?? reject("lock_required", lock, transitions);
						if (!lock.cutover_in_flight) return reject("not_pinned", lock, transitions);
						// Success means the coordinator durably published/versioned and accepted this pinned batch.
						if (options.succeeded) yield* sql`DELETE FROM staging WHERE lock_id = ${lock.id}`;
						if (lock.pending_release || (options.succeeded && options.release)) {
							transitions.push(yield* drop(lock, lock.pending_release ?? "released"));
							return { value: null, transitions };
						}
						yield* sql`UPDATE edit_lock SET cutover_in_flight = 0, expires = ${now + lock.ttl_seconds * 1000} WHERE id = ${lock.id}`;
						transitions.push({
							type: "finished",
							lock_id: lock.id,
							holder_family: lock.holder_family,
							agent: lock.agent,
							staged: [],
							deferred: false,
						});
						return { value: { ...lock, cutover_in_flight: 0, expires: now + lock.ttl_seconds * 1000 }, transitions };
					}),
				false,
			),
		recover: sql.withTransaction(
			Effect.gen(function* () {
				const lock = yield* read;
				const transitions: Transition[] = [];
				if (lock?.cutover_in_flight) transitions.push(yield* drop(lock, "interrupted"));
				yield* sql`DELETE FROM staging WHERE lock_id NOT IN (SELECT id FROM edit_lock)`;
				return transitions;
			}),
		),
	};
	function releaseTrusted(reason: "broken" | "revoked", family?: string, id?: string) {
		return admit<Lock | null>((lock, _now, transitions) =>
			Effect.gen(function* () {
				if (lock && id !== undefined && lock.id !== id) return reject("stale_lock", lock, transitions);
				if (!lock || (family !== undefined && lock.holder_family !== family)) return { value: lock, transitions };
				if (lock.cutover_in_flight) {
					yield* sql`UPDATE edit_lock SET pending_release = ${lock.pending_release ?? reason} WHERE id = ${lock.id}`;
					transitions.push({
						type: reason,
						lock_id: lock.id,
						holder_family: lock.holder_family,
						agent: lock.agent,
						staged: [],
						deferred: true,
					});
					return { value: { ...lock, pending_release: lock.pending_release ?? reason }, transitions };
				}
				transitions.push(yield* drop(lock, reason));
				return { value: null, transitions };
			}),
		);
	}
});

/** Durable ownership and staged source; never publishes files or claims event delivery. */
export class EditLock extends Context.Service<EditLock, Effect.Success<typeof make>>()("comms/boot/EditLock") {}
export const layer = Layer.effect(EditLock, make);
