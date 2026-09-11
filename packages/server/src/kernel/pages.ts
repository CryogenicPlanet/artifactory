import { makePageContinuation, pendingPageMove } from "./topic-page-continuation.ts";
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema, type PlatformError } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel } from "./boot-channel.ts";
import { assertSqlPublished } from "./sql-publication.ts";
import { HealthProbe } from "./health-probe.ts";
import { publishedTopics } from "./published-topics.ts";
import { pageMarkdown } from "../page-markdown.ts";
import { validTopic } from "./messages.ts";

export class PageRejected extends Schema.TaggedError<PageRejected>()("PageRejected", {
	code: Schema.Literals(["page_not_found", "page_path_invalid", "pages_unavailable", "pages_move_pending"]),
}) {}
const validPath = (name: string) =>
	name === "" ||
	(!/[\\:]/.test(name) &&
		Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
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
			));
const make = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const render = pageMarkdown();
		const move = yield* makePageContinuation(directory);
		const sql = yield* SqlClient.SqlClient;
		const boot = yield* BootChannel;
		const visible = (name: string) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT epoch FROM kernel_writer`;
						if ((yield* pendingPageMove(sql, name)).length)
							return yield* new PageRejected({ code: "pages_move_pending" });
						const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
						const ceiling = probe ? yield* Ref.get(probe.ceiling) : (yield* boot.fence).published_through;
						if (!probe) yield* assertSqlPublished(sql, boot.epoch, ceiling);
						const deleted =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE deleted_at IS NOT NULL AND (path=${name} OR substr(${name},1,length(path)+1)=path||'/') LIMIT 1`;
						if (deleted.length) return yield* new PageRejected({ code: "page_not_found" });
					}),
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "PageRejected" ? error : new PageRejected({ code: "pages_unavailable" }),
					),
				);

		const resolve = Effect.fn("Pages.resolve")(
			function* (name: string) {
				if (!validPath(name)) return yield* new PageRejected({ code: "page_path_invalid" });
				yield* visible(name);
				const parent = yield* fs.realPath(path.dirname(directory));
				const root = path.join(parent, path.basename(directory));
				let target = root;
				for (const part of ["", ...name.split("/").filter(Boolean)]) {
					target = part ? path.join(target, part) : target;
					const canonical = yield* fs.realPath(target);
					if (canonical !== target) return yield* new PageRejected({ code: "page_path_invalid" });
				}
				const info = yield* fs.stat(target);
				if (info.type !== "File" && info.type !== "Directory")
					return yield* new PageRejected({ code: "page_path_invalid" });
				return { absolute: target, type: info.type };
			},
			(effect) =>
				effect.pipe(
					Effect.mapError((error) =>
						error._tag === "PageRejected"
							? error
							: new PageRejected({
									code: error.reason._tag === "NotFound" ? "page_not_found" : "pages_unavailable",
								}),
					),
				),
		);
		const entries = Effect.fn("Pages.entries")(function* (name: string, publicOnly = false) {
			const target = yield* resolve(name);
			if (target.type !== "Directory") return yield* new PageRejected({ code: "page_not_found" });
			const names = yield* fs.readDirectory(target.absolute);
			const publicChildren = publicOnly
				? yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* sql`SELECT epoch FROM kernel_writer`;
								const ceiling = (yield* boot.fence).published_through;
								yield* assertSqlPublished(sql, boot.epoch, ceiling);
								return yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)})
				 SELECT path,meta FROM visible_topics topic WHERE (parent=${name} OR (${name}='' AND parent IS NULL)) AND deleted_at IS NULL
				 AND NOT EXISTS (SELECT 1 FROM visible_topics ancestor WHERE ancestor.deleted_at IS NOT NULL
				 AND (ancestor.path=topic.path OR substr(topic.path,1,length(ancestor.path)+1)=ancestor.path||'/'))`.pipe(
									Effect.flatMap(
										Schema.decodeUnknownEffect(
											Schema.Array(
												Schema.Struct({ path: Schema.String, meta: Schema.fromJsonString(Schema.JsonObject) }),
											),
										),
									),
									Effect.map((rows) => rows.filter((row) => row.meta.public === true).map((row) => row.path)),
								);
							}),
						)
						.pipe(Effect.mapError(() => new PageRejected({ code: "pages_unavailable" })))
				: null;
			const result: Array<{ readonly name: string; readonly directory: boolean }> = [];
			for (const child of names.sort()) {
				const childName = name ? `${name}/${child}` : child;
				const entry = yield* resolve(childName).pipe(
					Effect.catchTag("PageRejected", (error) =>
						error.code === "pages_unavailable" ? Effect.fail(error) : Effect.succeed(null),
					),
				);
				if (entry && (entry.type !== "Directory" || publicChildren === null || publicChildren.includes(childName)))
					result.push({ name: child, directory: entry.type === "Directory" });
			}
			return result;
		});
		const read = Effect.fn("Pages.read")(function* (name: string) {
			const target = yield* resolve(name);
			if (target.type !== "File") return yield* new PageRejected({ code: "page_not_found" });
			return yield* fs.readFileString(target.absolute);
		});
		const topic = Effect.fn("Pages.topic")(function* (name: string, depth = 1) {
			const first = yield* entries(name).pipe(
				Effect.catchTag("PageRejected", (error) =>
					error.code === "page_not_found" || error.code === "pages_move_pending"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			);
			if (!first) return { exists: false, index: null, pages: [], directories: [] };
			const directories: string[] = [];
			const visit = (
				base: string,
				children: typeof first,
				remaining: number,
			): Effect.Effect<void, PageRejected | PlatformError.PlatformError> =>
				Effect.gen(function* () {
					for (const child of children) {
						const childName = base ? `${base}/${child.name}` : child.name;
						if (!child.directory || !validTopic(childName)) continue;
						directories.push(childName);
						if (remaining > 1) yield* visit(childName, yield* entries(childName), remaining - 1);
					}
				});
			yield* visit(name, first, depth);
			const pages = first.filter((entry) => !entry.directory).map((entry) => entry.name);
			return {
				exists: true,
				index: pages.includes("index.md") ? yield* read(name ? `${name}/index.md` : "index.md") : null,
				pages,
				directories,
			};
		});
		const publicTopic = (name: string, ceiling: number) =>
			sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE path=${name} AND deleted_at IS NULL AND json_type(meta,'$.public')='true'`.pipe(
				Effect.map((rows) => rows.length === 1),
			);
		return { resolve, entries, read, topic, render, move, publicTopic };
	});
/** Reads only the page tree supplied by boot. Paths never follow symlinks. */
export class Pages extends Context.Service<Pages, Effect.Success<ReturnType<typeof make>>>()("comms/server/Pages") {}
export const layer = (directory: string) => Layer.effect(Pages, make(directory));
