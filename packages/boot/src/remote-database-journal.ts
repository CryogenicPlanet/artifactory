import type { RemoteStore } from "@comms/storage/store";
import { Crypto, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export class RemoteDatabaseError extends Schema.TaggedError<RemoteDatabaseError>()("RemoteDatabaseError", {
	code: Schema.Literals([
		"remote_database_invalid",
		"remote_database_provision_failed",
		"remote_database_cleanup_required",
		"scratch_limit",
		"mysql_clone_objects_unsupported",
	]),
}) {}
const Record = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["dump", "rehearsal", "restore"]),
	endpoint: Schema.String,
	database: Schema.String,
	principal: Schema.String,
	phase: Schema.Literals(["allocated", "ready", "closed"]),
	database_created: Schema.optionalKey(Schema.Literal(true)),
});
export type RemoteDatabaseRecord = typeof Record.Type;
const Encoded = Schema.fromJsonString(Record);
const Secret = Schema.fromJsonString(Schema.Struct({ password: Schema.String }));
const invalid = () => new RemoteDatabaseError({ code: "remote_database_invalid" });
const urlOf = (store: RemoteStore) => Effect.try({ try: () => new URL(Redacted.value(store.url)), catch: invalid });
const role = (id: string) => `comms_t_${id.replaceAll("-", "").slice(0, 24)}`;
const database = (kind: "rehearsal" | "restore", id: string) =>
	`comms_${kind === "restore" ? "app" : "rehearsal"}_${id.replaceAll("-", "")}`;

/** Metadata commits before any CREATE ROLE / DATABASE. Passwords live only in a boot-owned file. */
export const remoteDatabaseJournal = (bootStore: RemoteStore, dataDirectory: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const bootUrl = yield* urlOf(bootStore);
		const endpoint = `${bootStore._tag}://${bootUrl.hostname}:${bootUrl.port || (bootStore._tag === "postgres" ? "5432" : "3306")}`;
		const directory = path.join(dataDirectory, "remote-credentials");
		const key = (id: string) => `remote_database:${id}`;
		const filename = (id: string) => path.join(directory, `${id}.json`);
		const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
		const validate = (record: RemoteDatabaseRecord) => {
			if (
				!validId(record.id) ||
				record.endpoint !== endpoint ||
				record.principal !== role(record.id) ||
				(record.kind !== "dump" && record.database !== database(record.kind, record.id))
			)
				return Effect.fail(invalid());
			return Effect.succeed(record);
		};
		const read = (id: string) =>
			Effect.gen(function* () {
				if (!validId(id)) return yield* invalid();
				const rows = yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${key(id)}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				);
				if (rows.length !== 1 || !rows[0]) return yield* invalid();
				const record = yield* Schema.decodeEffect(Encoded)(rows[0].value).pipe(Effect.mapError(invalid));
				if (record.id !== id) return yield* invalid();
				return yield* validate(record);
			});
		const syncDirectory = Effect.scoped(fs.open(directory).pipe(Effect.flatMap((file) => file.sync)));
		const allocate = (kind: RemoteDatabaseRecord["kind"], source: RemoteStore) =>
			Effect.gen(function* () {
				// A nested transaction could roll back the intent after external DDL starts.
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return yield* invalid();
				const sourceUrl = yield* urlOf(source);
				if (
					`${source._tag}://${sourceUrl.hostname}:${sourceUrl.port || (source._tag === "postgres" ? "5432" : "3306")}` !==
					endpoint
				)
					return yield* invalid();
				const id = yield* crypto.randomUUIDv4;
				const record: RemoteDatabaseRecord = {
					id,
					kind,
					endpoint,
					database: kind === "dump" ? source.database : database(kind, id),
					principal: role(id),
					phase: "allocated",
				};
				yield* sql`INSERT INTO settings(${sql("key")},value) VALUES(${key(id)},${yield* Schema.encodeEffect(Encoded)(record)})`;
				const password = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
				yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
				yield* fs.chmod(directory, 0o700);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(filename(id), { flag: "wx", mode: 0o600 });
						yield* file.writeAll(new TextEncoder().encode(yield* Schema.encodeEffect(Secret)({ password })));
						yield* file.sync;
					}),
				);
				yield* syncDirectory;
				yield* Effect.scoped(fs.open(dataDirectory).pipe(Effect.flatMap((file) => file.sync)));
				return record;
			});
		const credential = (id: string) =>
			Effect.gen(function* () {
				const record = yield* read(id);
				const file = filename(id);
				const info = yield* fs.stat(file);
				if (
					(yield* fs.realPath(file)) !== path.join(yield* fs.realPath(directory), `${id}.json`) ||
					info.type !== "File" ||
					(info.mode & 0o077) !== 0 ||
					((yield* fs.stat(directory)).mode & 0o077) !== 0
				)
					return yield* invalid();
				const secret = yield* fs
					.readFileString(file)
					.pipe(Effect.flatMap(Schema.decodeEffect(Secret)), Effect.mapError(invalid));
				if (!/^[0-9a-f]{64}$/.test(secret.password)) return yield* invalid();
				const url = yield* urlOf(bootStore);
				url.username = record.principal;
				url.password = secret.password;
				url.pathname = `/${encodeURIComponent(record.database)}`;
				return { _tag: bootStore._tag, database: record.database, url: Redacted.make(url.href) } satisfies RemoteStore;
			});
		const phase = (id: string, expected: RemoteDatabaseRecord["phase"], next: RemoteDatabaseRecord["phase"]) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${key(id)} FOR UPDATE`;
					const record = yield* read(id);
					if (
						record.phase !== expected ||
						expected === "closed" ||
						next === "allocated" ||
						(expected === "ready" && next !== "closed")
					)
						return yield* invalid();
					const updated = { ...record, phase: next };
					yield* sql`UPDATE settings SET value=${yield* Schema.encodeEffect(Encoded)(updated)} WHERE ${sql("key")}=${key(id)}`;
					return updated;
				}),
			);
		const forget = (id: string) =>
			Effect.gen(function* () {
				const record = yield* read(id);
				if (record.phase !== "closed")
					return yield* new RemoteDatabaseError({ code: "remote_database_cleanup_required" });
				yield* fs.remove(filename(id), { force: true });
				if (yield* fs.exists(directory)) yield* syncDirectory;
				// Restore databases are retained even before selection; their records remain discoverable.
				if (record.kind !== "restore") yield* sql`DELETE FROM settings WHERE ${sql("key")}=${key(id)}`;
			});
		const list = Effect.gen(function* () {
			const rows =
				yield* sql`SELECT ${sql("key")} AS key,value FROM settings WHERE ${sql("key")} LIKE ${"remote^_database:%"} ESCAPE '^'`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
					),
				);
			return yield* Effect.forEach(rows, (row) =>
				Schema.decodeEffect(Encoded)(row.value).pipe(
					Effect.mapError(invalid),
					Effect.flatMap(validate),
					Effect.flatMap((record) => (row.key === key(record.id) ? Effect.succeed(record) : Effect.fail(invalid()))),
				),
			);
		});
		const created = (record: RemoteDatabaseRecord, _resource: "database") =>
			Effect.gen(function* () {
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return yield* invalid();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${key(record.id)} FOR UPDATE`;
						const saved = yield* read(record.id);
						if (
							saved.phase !== "allocated" ||
							saved.kind === "dump" ||
							saved.database !== record.database ||
							saved.endpoint !== record.endpoint
						)
							return yield* invalid();
						yield* sql`UPDATE settings SET value=${yield* Schema.encodeEffect(Encoded)({ ...saved, database_created: true })} WHERE ${sql("key")}=${key(saved.id)}`;
					}),
				);
			});
		const owns = (record: RemoteDatabaseRecord, _resource: "database") =>
			read(record.id).pipe(
				Effect.map(
					(saved) =>
						saved.database === record.database && saved.endpoint === record.endpoint && saved.database_created === true,
				),
			);
		return { allocate, read, list, credential, phase, forget, created, owns };
	});
