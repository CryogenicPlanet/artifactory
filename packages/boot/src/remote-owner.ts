import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { type RemoteSession } from "@comms/storage/remote-session";

const Session = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	server: Schema.String,
	database: Schema.String,
	username: Schema.String,
	connectionId: Schema.String,
	tag: Schema.String,
});
export const RemoteOwnerIntent = Schema.Struct({
	attempt: Schema.String,
	root: Schema.String,
	scope: Schema.Literals(["database", "account"]),
	engine: Schema.Literals(["pg", "mysql"]),
	database: Schema.String,
	host: Schema.String,
	port: Schema.Int,
	tls: Schema.Boolean,
	username: Schema.String,
});
export type RemoteOwnerIntent = typeof RemoteOwnerIntent.Type;
const Owner = Schema.Struct({
	...RemoteOwnerIntent.fields,
	inspector: Schema.NullOr(Session),
	state: Schema.Literals(["pending", "closed"]),
	sessions: Schema.Array(Session),
});

export class RemoteOwnerRejected extends Schema.TaggedError<RemoteOwnerRejected>()("RemoteOwnerRejected", {
	code: Schema.Literals(["remote_owner_invalid", "remote_owner_unclosed", "remote_owner_closed"]),
}) {}
const validAttempt = (id: string) => /^[a-f0-9]{64}$/.test(id);
const invalid = () => new RemoteOwnerRejected({ code: "remote_owner_invalid" });
const inspectorMatches = (owner: RemoteOwnerIntent, session: RemoteSession) =>
	session.engine === owner.engine &&
	session.database === owner.database &&
	session.server.length > 0 &&
	/^[1-9][0-9]*$/.test(session.connectionId) &&
	session.tag === `inspect:${Buffer.from(owner.attempt, "hex").toString("base64url")}` &&
	(session.username === owner.username ||
		(owner.engine === "mysql" && session.username.startsWith(`${owner.username}@`)));
const registrationMatches = (owner: RemoteOwnerIntent, inspector: RemoteSession, session: RemoteSession) =>
	session.engine === owner.engine &&
	session.database.length > 0 &&
	(owner.scope === "account" || session.database === owner.database) &&
	session.server === inspector.server &&
	session.username === inspector.username &&
	/^[1-9][0-9]*$/.test(session.connectionId) &&
	session.tag === `comms:${Buffer.from(owner.attempt, "hex").toString("base64url")}`;

/** Only terminal local receipts authorize restart; a new server observation never repairs an old intent. */
export const recoverRemoteOwners = (dataDirectory: string, expected: readonly RemoteOwnerIntent[]) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = path.join(dataDirectory, "remote-owners");
		if (!(yield* fs.exists(directory))) {
			if (expected.length > 0) return yield* invalid();
			return;
		}
		const seen = new Set<string>();
		if ((yield* fs.realPath(directory)) !== directory) return yield* invalid();
		for (const name of yield* fs.readDirectory(directory)) {
			// A fixed replacement file never supersedes the authoritative intent by itself.
			if (/^[a-f0-9]{64}\.json\.tmp$/.test(name)) continue;
			if (/^[a-f0-9]{64}\.intent$/.test(name)) {
				if (!(yield* fs.exists(path.join(directory, `${name.slice(0, -7)}.json`)))) return yield* invalid();
				continue;
			}
			const attempt = name.slice(0, -5);
			if (!name.endsWith(".json") || !validAttempt(attempt)) return yield* invalid();
			const selected = expected.find((item) => item.attempt === attempt);
			if (!selected || seen.has(attempt)) return yield* invalid();
			seen.add(attempt);
			const filename = path.join(directory, name);
			if ((yield* fs.realPath(filename)) !== filename) return yield* invalid();
			const owner = yield* fs
				.readFileString(filename)
				.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Owner))), Effect.mapError(invalid));
			const intentPath = path.join(directory, `${attempt}.intent`);
			if ((yield* fs.realPath(intentPath)) !== intentPath) return yield* invalid();
			const intent = yield* fs
				.readFileString(intentPath)
				.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Owner))), Effect.mapError(invalid));
			const encode = Schema.encodeSync(Schema.fromJsonString(Owner));
			if (
				encode(intent) !== encode({ ...selected, state: "pending", sessions: [], inspector: null }) ||
				encode(intent) !== encode({ ...owner, state: "pending", sessions: [], inspector: null })
			)
				return yield* invalid();
			if (
				owner.attempt !== attempt ||
				!validAttempt(owner.root) ||
				!owner.host ||
				!owner.username ||
				owner.port < 1 ||
				owner.port > 65535
			)
				return yield* invalid();
			if (
				owner.state === "closed" &&
				(!owner.inspector ||
					!inspectorMatches(owner, owner.inspector) ||
					owner.sessions.some((session) => !owner.inspector || !registrationMatches(owner, owner.inspector, session)) ||
					new Set(owner.sessions.map((session) => session.connectionId)).size !== owner.sessions.length)
			)
				return yield* invalid();
			if (owner.state !== "closed") return yield* new RemoteOwnerRejected({ code: "remote_owner_unclosed" });
		}
		if (seen.size !== expected.length) return yield* invalid();
	});

/** Call before opening inspectors or writer pools. All state belongs to this owner instance. */
export const remoteOwner = (
	dataDirectory: string,
	selected: RemoteOwnerIntent,
	fileOwnership?: { readonly uid: 1000; readonly gid: 1000 },
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (
			!validAttempt(selected.attempt) ||
			!validAttempt(selected.root) ||
			!selected.database ||
			!selected.host ||
			!selected.username ||
			!Number.isSafeInteger(selected.port) ||
			selected.port < 1 ||
			selected.port > 65535
		)
			return yield* invalid();
		const directory = path.join(dataDirectory, "remote-owners");
		yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
		if ((yield* fs.realPath(directory)) !== directory) return yield* invalid();
		if (fileOwnership) yield* fs.chown(directory, fileOwnership.uid, fileOwnership.gid);
		yield* Effect.scoped(fs.open(dataDirectory).pipe(Effect.flatMap((file) => file.sync)));
		const filename = path.join(directory, `${selected.attempt}.json`);
		const gate = yield* Semaphore.make(1);
		const closure = yield* Semaphore.make(1);
		const encode = Schema.encodeSync(Schema.fromJsonString(Owner));
		const initial: typeof Owner.Type = { ...selected, state: "pending", sessions: [], inspector: null };
		const write = (name: string, value: typeof Owner.Type, flag: "wx" | "w") =>
			Effect.scoped(
				Effect.gen(function* () {
					const file = yield* fs.open(name, { flag, mode: 0o600 });
					yield* file.writeAll(new TextEncoder().encode(encode(value)));
					if (fileOwnership) yield* fs.chown(name, fileOwnership.uid, fileOwnership.gid);
					yield* file.sync;
				}),
			);
		const syncDirectory = Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
		// A partial initial write is a retained refusal, never evidence that no connection existed.
		yield* write(path.join(directory, `${selected.attempt}.intent`), initial, "wx");
		yield* syncDirectory;
		yield* write(filename, initial, "wx");
		yield* syncDirectory;
		let current = initial;
		let closing = false;
		const save = (next: typeof Owner.Type) =>
			Effect.gen(function* () {
				const temporary = `${filename}.tmp`;
				yield* write(temporary, next, "w");
				yield* fs.rename(temporary, filename);
				yield* syncDirectory;
				current = next;
			});
		return {
			bindInspector: (session: RemoteSession) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (closing || current.inspector || !inspectorMatches(selected, session)) return yield* invalid();
						yield* save({ ...current, inspector: session });
					}),
				),
			register: (session: RemoteSession) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (closing || current.state !== "pending")
							return yield* new RemoteOwnerRejected({ code: "remote_owner_closed" });
						if (!current.inspector || !registrationMatches(selected, current.inspector, session))
							return yield* invalid();
						const existing = current.sessions.find((item) => item.connectionId === session.connectionId);
						if (existing) {
							if (
								Schema.encodeSync(Schema.fromJsonString(Session))(existing) !==
								Schema.encodeSync(Schema.fromJsonString(Session))(session)
							)
								return yield* invalid();
							return;
						}
						yield* save({ ...current, sessions: [...current.sessions, session] });
					}),
				),
			/** Supplied proof must close registration, prove local closure, inspect all account sessions/XA, and preserve inspector continuity. */
			close: <E, R>(proof: Effect.Effect<void, E, R>) =>
				closure.withPermit(
					Effect.gen(function* () {
						const done = yield* gate.withPermit(
							Effect.sync(() => {
								closing = true;
								return current.state === "closed";
							}),
						);
						if (done) return;
						// Do not hold the journal gate while inspector admission drains pending registration callbacks.
						yield* proof;
						yield* gate.withPermit(
							Effect.gen(function* () {
								if (!current.inspector) return yield* invalid();
								yield* save({ ...current, state: "closed" });
							}),
						);
					}),
				),
		};
	});
