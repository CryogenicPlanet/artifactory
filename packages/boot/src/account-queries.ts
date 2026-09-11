import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Scope } from "./enrollment-schema.ts";

export const EnrollmentStatus = Schema.Literals(["pending", "approved", "denied", "collected", "expired"]);
const enrollmentRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: Schema.String,
	host: Schema.String,
	user_code: Schema.String,
	status: EnrollmentStatus,
	created_at: Schema.Int,
	expires_at: Schema.Int,
	scopes: Schema.NullOr(Schema.fromJsonString(Schema.Array(Scope))),
	family: Schema.NullOr(Schema.String),
});
const familyRow = Schema.Struct({
	family: Schema.String,
	agent: Schema.String,
	label: Schema.String,
	scopes: Schema.fromJsonString(Schema.Array(Scope)),
	created_at: Schema.Int,
	last_used_at: Schema.NullOr(Schema.Int),
	access_expires_at: Schema.NullOr(Schema.Int),
	refresh_expires_at: Schema.NullOr(Schema.Int),
	revoked: Schema.Literals([0, 1]),
});
export interface AccountPage {
	readonly limit: number;
	readonly before: string | null;
}

/** Read-only projections compose into Auth; each page is one SQL snapshot. IDs sort lexically, not by time. */
export const makeAccountQueries = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const listEnrollments = Effect.fn("Auth.listEnrollments")(function* (
		page: AccountPage & { readonly status: typeof EnrollmentStatus.Type | null },
	) {
		const now = yield* Clock.currentTimeMillis;
		const rows = yield* sql`WITH visible AS (
			SELECT id, agent_name AS name, kind, host, user_code,
			CASE WHEN status IN ('pending','approved') AND expires_at <= ${now} THEN 'expired' ELSE status END AS status,
			created_at, expires_at, scopes,
			CASE WHEN status IN ('approved','collected') THEN family ELSE NULL END AS family
			FROM enrollments
		) SELECT id, name, kind, host, user_code, status, created_at, expires_at, scopes, family FROM visible
		WHERE (${page.status} IS NULL OR status = ${page.status}) AND (${page.before} IS NULL OR id < ${page.before})
		ORDER BY id DESC LIMIT ${page.limit + 1}`;
		const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))(rows);
		const items = decoded.slice(0, page.limit);
		return { items, next: decoded.length > page.limit ? (items.at(-1)?.id ?? null) : null };
	});
	const listTokenFamilies = Effect.fn("Auth.listTokenFamilies")(function* (page: AccountPage) {
		// Family identity/scopes are immutable across rotation. Aggregate all pairs, including expired use evidence.
		const rows = yield* sql`SELECT family, MIN(agent) AS agent, MIN(label) AS label, MIN(scopes) AS scopes,
		MIN(created_at) AS created_at, MAX(last_used_at) AS last_used_at,
		MAX(CASE WHEN kind = 'access' THEN expires_at END) AS access_expires_at,
		MAX(CASE WHEN kind = 'refresh' THEN expires_at END) AS refresh_expires_at,
		MIN(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
		FROM tokens WHERE (${page.before} IS NULL OR family < ${page.before})
		GROUP BY family ORDER BY family DESC LIMIT ${page.limit + 1}`;
		const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(familyRow))(rows);
		const items = decoded.slice(0, page.limit).map((row) => ({ ...row, revoked: row.revoked === 1 }));
		return { items, next: decoded.length > page.limit ? (items.at(-1)?.family ?? null) : null };
	});
	return { listEnrollments, listTokenFamilies };
});
