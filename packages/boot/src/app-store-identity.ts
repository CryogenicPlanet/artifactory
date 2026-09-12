import { backupPath } from "./backup-metadata.ts";
import { Clock, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { EventError } from "./events.ts";

const Adoption = Schema.Struct({
	store_id: Schema.String,
	initialized_at: Schema.Int,
	filename: Schema.String,
	mode: Schema.Literals(["fresh", "legacy"]),
	phase: Schema.Literals(["pending", "ready"]),
});
type Adoption = typeof Adoption.Type;
const Identity = Schema.Struct({
	singleton: Schema.Int,
	store_id: Schema.String,
	initialized_at: Schema.Int,
	transferred_to: Schema.NullOr(Schema.String),
});
const invalid = () => new EventError({ code: "app_store_identity_invalid" });

/** Boot's durable handshake is separate from the app transaction. No layer construction opens the app. */
export const appStoreIdentity = (filename: string, dataDirectory?: string) =>
	Effect.gen(function* () {
		const boot = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const canonical = Effect.gen(function* () {
			const parent = yield* fs.realPath(path.dirname(filename));
			const selected = path.join(parent, path.basename(filename));
			const exists = (yield* fs.readDirectory(parent)).includes(path.basename(filename));
			if (exists && ((yield* fs.realPath(filename)) !== selected || (yield* fs.stat(filename)).type !== "File"))
				return yield* invalid();
			return { selected, exists };
		});
		// Nonisolated startup already permits a journal-selected replacement without the current file.
		// Isolated layout's earlier missing-file refusal is deliberately unchanged.
		const selectedBackup = Effect.gen(function* () {
			const rows = yield* boot`SELECT b.id,b.path,b.engine FROM backups b WHERE b.id IN (
		 SELECT backup FROM cutover WHERE phase='restoring'
		 UNION SELECT CASE WHEN phase='rollback' THEN safety_backup ELSE backup END FROM db_restore_requests WHERE phase IN ('restoring','rollback')
		)`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(
							Schema.Struct({
								id: Schema.String,
								path: Schema.String,
								engine: Schema.Literals(["sqlite", "pg", "mysql"]),
							}),
						),
					),
				),
			);
			if (rows.length !== 1 || !rows[0]) return false;
			const row = rows[0];
			const directory = path.join(dataDirectory ?? path.dirname(filename), "backups");
			if (
				row.engine !== "sqlite" ||
				row.path !== backupPath(path, dataDirectory ?? path.dirname(filename), row.id) ||
				!(yield* fs.exists(row.path))
			)
				return false;
			return (
				(yield* fs.stat(row.path)).type === "File" &&
				(yield* fs.realPath(row.path)) === path.join(yield* fs.realPath(directory), `${row.id}.db`)
			);
		});
		const read = Effect.gen(function* () {
			const rows =
				yield* boot`SELECT key,value FROM settings WHERE key IN ('app_store_adoption','app_store_id','app_store_initialized')`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
					),
				);
			const saved = rows.find((row) => row.key === "app_store_adoption")?.value;
			const id = rows.find((row) => row.key === "app_store_id")?.value;
			const initialized = rows.some((row) => row.key === "app_store_initialized");
			if (saved === undefined) {
				if (id !== undefined) return yield* invalid();
				return { adoption: undefined, initialized };
			}
			const adoption = yield* Schema.decodeEffect(Schema.fromJsonString(Adoption))(saved).pipe(
				Effect.mapError(invalid),
			);
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(adoption.store_id) ||
				adoption.initialized_at < 0 ||
				(adoption.phase === "ready" ? id !== adoption.store_id || !initialized : id !== undefined)
			)
				return yield* invalid();
			return { adoption, initialized };
		});
		const reserve = boot.withTransaction(
			Effect.gen(function* () {
				const { selected, exists } = yield* canonical;
				const state = yield* read;
				if (
					(state.initialized || state.adoption?.mode === "legacy" || state.adoption?.phase === "ready") &&
					!exists &&
					!(yield* selectedBackup)
				)
					return yield* new EventError({ code: "app_store_missing" });
				if (state.adoption) {
					if (state.adoption.filename !== selected) return yield* invalid();
					return state.adoption;
				}
				const adoption: Adoption = {
					store_id: yield* crypto.randomUUIDv4,
					initialized_at: yield* Clock.currentTimeMillis,
					filename: selected,
					mode: state.initialized || exists ? "legacy" : "fresh",
					phase: "pending",
				};
				yield* boot`INSERT INTO settings(key,value) VALUES('app_store_adoption',${Schema.encodeSync(Schema.fromJsonString(Adoption))(adoption)})`;
				return adoption;
			}),
		);
		const current = read.pipe(
			Effect.flatMap(({ adoption }) => (adoption ? Effect.succeed(adoption) : Effect.fail(invalid()))),
		);
		const complete = (adoption: Adoption) =>
			boot.withTransaction(
				Effect.gen(function* () {
					const saved = yield* current;
					if (saved.store_id !== adoption.store_id) return yield* invalid();
					if (saved.phase === "pending" && saved.mode === "legacy")
						yield* boot`UPDATE backups SET legacy_store_id=${adoption.store_id} WHERE legacy_store_id IS NULL AND engine='sqlite'`;
					yield* boot`INSERT INTO settings(key,value) VALUES('app_store_id',${adoption.store_id}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
					yield* boot`INSERT OR IGNORE INTO settings(key,value) VALUES('app_store_initialized','1')`;
					yield* boot`UPDATE settings SET value=${Schema.encodeSync(Schema.fromJsonString(Adoption))({ ...saved, phase: "ready" })} WHERE key='app_store_adoption'`;
				}),
			);
		return { reserve, current, complete };
	});

/** Called inside the app transaction, before the writer fence or publication evidence is changed. */
export const verifyAppIdentity = (adoption: Adoption, allowMissing: boolean) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const tables = yield* sql`SELECT type FROM sqlite_master WHERE name='store_identity'`;
		if (tables.length === 0) {
			if (!allowMissing) return yield* new EventError({ code: "app_store_missing" });
			yield* sql`CREATE TABLE store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)`;
			yield* sql`INSERT INTO store_identity VALUES(1,${adoption.store_id},${adoption.initialized_at},NULL)`;
			return;
		}
		const rows = yield* sql`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Identity))),
			Effect.mapError(invalid),
		);
		const row = rows[0];
		if (rows.length === 0) return yield* new EventError({ code: "app_store_missing" });
		if (rows.length !== 1 || !row || row.singleton !== 1 || row.initialized_at < 0 || row.transferred_to !== null)
			return yield* invalid();
		if (row.store_id !== adoption.store_id) return yield* new EventError({ code: "app_store_missing" });
	});

export const isAppStoreIdentityError = (
	error: unknown,
): error is EventError & { readonly code: "app_store_missing" | "app_store_identity_invalid" } =>
	Schema.is(EventError)(error) && (error.code === "app_store_missing" || error.code === "app_store_identity_invalid");
export const appIdentityPolicy = {
	status: 409,
	retriable: false,
	hint: "Preserve both stores and recovery journals. Inspect /_boot/status and the backup catalog; restore the matching board rather than initializing or replacing its identity.",
} as const;
