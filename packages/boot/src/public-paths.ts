import { isDescendant, on, replacePrefix } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { EventRecord } from "./events.ts";

export const pagePath = (name: string) =>
	name !== "" &&
	!/[\\:]/.test(name) &&
	Array.from(name).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
	name
		.split("/")
		.every(
			(part) =>
				part !== "" &&
				part !== "." &&
				part !== ".." &&
				part !== "node_modules" &&
				part !== ".vite" &&
				!part.startsWith(".comms-"),
		);

export const publicPathsSchema = (sql: SqlClient) => sql`CREATE TABLE public_paths (path TEXT PRIMARY KEY NOT NULL)`;
const Metadata = Schema.Struct({ path: Schema.String, meta: Schema.JsonObject });
const Deletion = Schema.Struct({ path: Schema.String });
const Snapshot = Schema.Struct({ paths: Schema.Array(Schema.String) });

/** Apply only with the first durable event append, in the same transaction as its publication fence. */
export const projectPublicPath = (sql: SqlClient, event: typeof EventRecord.Type) =>
	Effect.gen(function* () {
		if (event.type === "pages.public") {
			const value = yield* Schema.decodeUnknownEffect(Snapshot)(event.payload);
			if (
				event.topic !== null ||
				value.paths.some((path) => !pagePath(path)) ||
				new Set(value.paths).size !== value.paths.length
			)
				return false;
			// Activation replaces the complete policy, including topics removed by editable migrations.
			// The enclosing append transaction keeps the previous grants visible until commit.
			yield* sql`DELETE FROM public_paths`;
			for (const path of value.paths) yield* sql`INSERT INTO public_paths(path) VALUES(${path})`;
		} else if (event.type === "topic.meta") {
			const value = yield* Schema.decodeUnknownEffect(Metadata)(event.payload);
			if (value.path !== event.topic) return false;
			if (pagePath(value.path) && value.meta.public === true) {
				const collision = Effect.gen(function* () {
					const digest = on(sql, {
						sqlite: () => sql`NULL`,
						pg: () => sql`encode(sha256(${new TextEncoder().encode(value.path)}::bytea),'hex')`,
						mysql: () => sql`SHA2(${value.path},256)`,
					});
					const rows = yield* sql`SELECT path FROM public_paths WHERE path_hash=${digest}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
					);
					return rows.some((row) => row.path !== value.path);
				});
				if (yield* on(sql, { sqlite: () => Effect.succeed(false), pg: () => collision, mysql: () => collision }))
					return false;
				yield* sql`INSERT INTO public_paths(path) VALUES(${value.path}) ${on(sql, { sqlite: () => sql`ON CONFLICT(path) DO NOTHING`, pg: () => sql`ON CONFLICT(path_hash) DO NOTHING`, mysql: () => sql`ON DUPLICATE KEY UPDATE path=path` })}`;
			} else yield* sql`DELETE FROM public_paths WHERE path=${value.path}`;
		} else if (event.type === "topic.deleted") {
			const value = yield* Schema.decodeUnknownEffect(Deletion)(event.payload);
			if (value.path !== event.topic) return false;
			yield* sql`DELETE FROM public_paths WHERE path=${value.path}
				OR substr(path,1,length(${value.path})+1)=${value.path}||'/'`;
		}
		return true;
	});

export const movePublicPaths = (sql: SqlClient, from: string, to: string) =>
	sql`UPDATE public_paths SET path=${replacePrefix(sql, sql`path`, from, to)}
		WHERE path=${from} OR ${isDescendant(sql, sql`path`, sql`${from}`)}`;
