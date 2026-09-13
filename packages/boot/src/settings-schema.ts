import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const Days = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36500 }));
// Historical signed requests and receipts retain their original canonical shape for exact replay.
export const EventRetention = Schema.Struct({ http_request_days: Days, other_days: Days });
const Percent = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(100));
export const StoragePolicy = Schema.Struct({
	backup_percent: Percent,
	event_percent: Percent,
	headroom_percent: Percent.check(Schema.isGreaterThanOrEqualTo(5)),
}).check(Schema.makeFilter((value) => value.backup_percent + value.event_percent + value.headroom_percent < 100));

/** Exact canonical application paths only. Boot authorization and page publication remain separate authorities. */
export const validPublicPath = (path: string) =>
	/^\/[A-Za-z0-9._~!$&'()+,;=:@/-]*$/.test(path) &&
	path.length <= 512 &&
	!path.includes("//") &&
	!path.split("/").some((part) => part === "." || part === "..") &&
	![
		"/_boot",
		"/_kernel",
		"/auth",
		"/approve",
		"/setup",
		"/p",
		"/api/fs",
		"/api/lock",
		"/api/reload",
		"/api/revert",
		"/api/generations",
		"/api/events",
		"/api/tokens",
	].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
const PublicPaths = Schema.Array(Schema.String.check(Schema.makeFilter(validPublicPath))).check(
	Schema.isMaxLength(128),
	Schema.makeFilter((paths) => new Set(paths).size === paths.length),
);
export const Settings = Schema.Struct({
	revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	storage: StoragePolicy,
	public_paths: PublicPaths,
});
export const SettingsChange = Schema.Struct({
	revision: Settings.fields.revision,
	patch: Schema.Struct({
		event_retention: Schema.optionalKey(EventRetention),
		storage: Schema.optionalKey(StoragePolicy),
		public_paths: Schema.optionalKey(PublicPaths),
	}).check(Schema.makeFilter((patch) => Object.keys(patch).length > 0)),
});
export type SettingsChange = typeof SettingsChange.Type;
export const canonicalSettings = (params: SettingsChange, session: string) =>
	JSON.stringify({
		session,
		revision: params.revision,
		patch: {
			...(params.patch.event_retention === undefined
				? {}
				: {
						event_retention: {
							http_request_days: params.patch.event_retention.http_request_days,
							other_days: params.patch.event_retention.other_days,
						},
					}),
			...(params.patch.storage === undefined
				? {}
				: {
						storage: {
							backup_percent: params.patch.storage.backup_percent,
							event_percent: params.patch.storage.event_percent,
							headroom_percent: params.patch.storage.headroom_percent,
						},
					}),
			...(params.patch.public_paths === undefined ? {} : { public_paths: params.patch.public_paths.toSorted() }),
		},
	});
const Row = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }));
export const readSettings = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows =
		yield* sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")} IN ('storage_policy','public_paths','settings_revision')`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Row)),
		);
	const get = <A>(key: string, schema: Schema.ConstraintDecoder<A>, fallback: A) => {
		const row = rows.find((row) => row.key === key);
		return row ? Schema.decodeEffect(Schema.fromJsonString(schema))(row.value) : Effect.succeed(fallback);
	};
	return {
		revision: yield* get("settings_revision", Settings.fields.revision, 0),
		storage: yield* get("storage_policy", StoragePolicy, {
			backup_percent: 20,
			event_percent: 10,
			headroom_percent: 5,
		}),
		public_paths: yield* get("public_paths", PublicPaths, []),
	};
});
const readPolicy = <A>(key: string, schema: Schema.ConstraintDecoder<A>, fallback: A) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const row = (yield* sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")}=${key}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Row)),
		))[0];
		return row ? yield* Schema.decodeEffect(Schema.fromJsonString(schema))(row.value) : fallback;
	});
export const readStoragePolicy = readPolicy(
	"storage_policy",
	StoragePolicy,
	Object.freeze({
		backup_percent: 20,
		event_percent: 10,
		headroom_percent: 5,
	}),
);
export const readPublicPaths = readPolicy("public_paths", PublicPaths, Object.freeze([]));
