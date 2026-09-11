import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

const AgentInstance = Schema.Struct({
	agent: Schema.String,
	kind: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	created_at: Schema.Int,
	last_seen_at: Schema.NullOr(Schema.Int),
});

/** Historical families remain visible; presence is access admission, never an online guarantee. */
export const roster = (sql: SqlClient.SqlClient) =>
	sql`SELECT e.agent_name AS agent,e.kind,e.family AS instance,e.host AS label,
 e.collected_at AS created_at,MAX(t.last_used_at) AS last_seen_at
 FROM enrollments e LEFT JOIN tokens t ON t.family=e.family AND t.kind='access'
 WHERE e.status='collected' GROUP BY e.family
 UNION ALL
 SELECT t.agent,'agent' AS kind,t.family AS instance,t.label,MIN(t.created_at) AS created_at,MAX(t.last_used_at) AS last_seen_at
 FROM tokens t WHERE t.kind='access' AND NOT EXISTS
 (SELECT 1 FROM enrollments e WHERE e.family=t.family AND e.status='collected') GROUP BY t.family
 UNION ALL
 SELECT 'rahul' AS agent,'human' AS kind,id AS instance,'human' AS label,created_at,last_seen_at FROM sessions
 ORDER BY agent,created_at,instance`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentInstance))),
		Effect.map((items) => ({ items })),
	);
