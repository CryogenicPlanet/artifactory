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
			if (pagePath(value.path) && value.meta.public === true)
				yield* sql`INSERT INTO public_paths(path) VALUES(${value.path}) ON CONFLICT(path) DO NOTHING`;
			else yield* sql`DELETE FROM public_paths WHERE path=${value.path}`;
		} else if (event.type === "topic.deleted") {
			const value = yield* Schema.decodeUnknownEffect(Deletion)(event.payload);
			if (value.path !== event.topic) return false;
			yield* sql`DELETE FROM public_paths WHERE path=${value.path}
				OR substr(path,1,length(${value.path})+1)=${value.path + "/"}`;
		}
		return true;
	});

export const movePublicPaths = (sql: SqlClient, from: string, to: string) =>
	sql`UPDATE public_paths SET path=${to}||substr(path,length(${from})+1)
		WHERE path=${from} OR substr(path,1,length(${from})+1)=${from + "/"}`;
