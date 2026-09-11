import type { SqlClient } from "effect/unstable/sql/SqlClient";

// Use within the same snapshot-before-fence transaction as publishedMessages.
export const publishedTopics = (sql: SqlClient, ceiling: number) => sql`
 SELECT path,parent,name,last_seq,created_at,
  CASE WHEN updated_seq>${ceiling} THEN json_extract(previous,'$.meta') ELSE meta END AS meta,
  CASE WHEN updated_seq>${ceiling} THEN json_extract(previous,'$.archived_at') ELSE archived_at END AS archived_at,
  CASE WHEN updated_seq>${ceiling} THEN json_extract(previous,'$.deleted_at') ELSE deleted_at END AS deleted_at
 FROM topics WHERE updated_seq<=${ceiling} OR previous IS NOT NULL`;
