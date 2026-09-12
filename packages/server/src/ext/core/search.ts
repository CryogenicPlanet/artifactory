import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { Constructor } from "effect/unstable/sql/Statement";
import { KernelError } from "../../kernel/boot-channel.ts";

/** Parse once; caller text remains bound data, never SQL or search operators. */
export const searchMessages = (sql: Constructor, query: string, ceiling: number, folding = false) =>
	Effect.gen(function* () {
		const parts = query.trim().match(/"[^"]*"|[^\s"]+/gu) ?? [];
		if (
			query.length > 512 ||
			query.includes("\0") ||
			parts.length === 0 ||
			parts.length > 16 ||
			query.replace(/"[^"]*"|[^\s"]+|\s+/gu, "") !== "" ||
			parts.some((part) => !/[\p{L}\p{N}]/u.test(part))
		)
			return yield* new KernelError({ code: "query_invalid" });

		return on(sql, {
			sqlite: () => {
				const expression = parts.map((part) => `"${part.replaceAll('"', "")}"`).join(" AND ");
				return sql`id IN (
				 SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
				 WHERE messages_fts MATCH ${`body : (${expression})`} AND messages.updated_seq<=${ceiling}
				 UNION
				 SELECT message_id FROM messages_fts JOIN messages ON messages.id=messages_fts.message_id
				 WHERE messages_fts MATCH ${`previous_body : (${expression})`} AND messages.updated_seq>${ceiling}
				)`;
			},
			pg: () => {
				const expression = parts
					.map((part) =>
						part.startsWith('"')
							? sql`phraseto_tsquery('simple',${folding ? sql`public.comms_unaccent(${part.slice(1, -1)})` : sql`${part.slice(1, -1)}`})`
							: sql`plainto_tsquery('simple',${folding ? sql`public.comms_unaccent(${part})` : sql`${part}`})`,
					)
					.reduce((left, right) => sql`(${left} && ${right})`);
				return sql`id IN (SELECT id FROM messages WHERE
				 (updated_seq<=${ceiling} AND body_tsv @@ ${expression}) OR
				 (updated_seq>${ceiling} AND previous_body_tsv @@ ${expression}))`;
			},
			mysql: () => {
				// Keep phrase words intact: MySQL uses excluded internal words during phrase verification.
				// Quoting each sanitized part also prevents punctuation from becoming Boolean syntax.
				const expression = parts.map((part) => `+"${part.replace(/[+\-><()~*"@]/gu, " ").trim()}"`).join(" ");
				return sql`id IN (SELECT id FROM messages WHERE
				 (updated_seq<=${ceiling} AND MATCH(body) AGAINST (${expression} IN BOOLEAN MODE)) OR
				 (updated_seq>${ceiling} AND MATCH(previous_body) AGAINST (${expression} IN BOOLEAN MODE)))`;
			},
		});
	});
