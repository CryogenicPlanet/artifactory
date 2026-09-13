import { isDescendant, jsonText, jsonInt, on } from "@comms/storage/dialect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { publishedTopics } from "./published-topics.ts";

// Capture a SQL snapshot before reading boot's fence. Serialized writes publish before
// starting another mutation, so that snapshot can contain at most one unpublished image.
export const publishedMessages = (sql: SqlClient, ceiling: number) => sql`
 SELECT id,seq,topic,agent,instance,created_at,
  CASE WHEN updated_seq>${ceiling} THEN ${jsonText(sql, sql("previous"), "body")} ELSE body END AS body,
  CASE WHEN updated_seq>${ceiling} THEN ${jsonText(sql, sql("previous"), "tags")} ELSE ${on(sql, { sqlite: () => sql`tags`, pg: () => sql`tags::text`, mysql: () => sql`CAST(tags AS CHAR)` })} END AS tags,
  CASE WHEN updated_seq>${ceiling} THEN ${jsonText(sql, sql("previous"), "meta")} ELSE ${on(sql, { sqlite: () => sql`meta`, pg: () => sql`meta::text`, mysql: () => sql`CAST(meta AS CHAR)` })} END AS meta,
  CASE WHEN updated_seq>${ceiling} THEN ${jsonInt(sql, sql("previous"), "edited_at")} ELSE edited_at END AS edited_at,
  CASE WHEN updated_seq>${ceiling} THEN ${jsonInt(sql, sql("previous"), "deleted_at")} ELSE deleted_at END AS deleted_at
 FROM messages WHERE seq<=${ceiling}
 AND NOT EXISTS(SELECT 1 FROM (${publishedTopics(sql, ceiling)}) topic
  WHERE topic.deleted_at IS NOT NULL AND (messages.topic=topic.path OR ${isDescendant(sql, sql("messages.topic"), sql("topic.path"))}))`;
