import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Context, Effect, FileSystem, Layer, Path, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SourceRejected } from "./source-schema.ts";
import { Events } from "./events.ts";

export class PublicPagesUnavailable extends Schema.TaggedError<PublicPagesUnavailable>()(
	"PublicPagesUnavailable",
	{},
) {}
const topicPath = (name: string) =>
	name.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(name);
const pagePath = (name: string) =>
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
const Marker = Schema.fromJsonString(Schema.Struct({ path: Schema.String, children: Schema.Array(Schema.String) }));
const Row = Schema.Struct({
	path: Schema.String,
	meta: Schema.fromJsonString(Schema.JsonObject),
	deleted_at: Schema.NullOr(Schema.Int),
});
const make = (directory: string, operationGate: Semaphore.Semaphore, channelGate: Semaphore.Semaphore) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const events = yield* Events;
		const appRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provide(
					SqliteClient.layer({
						filename: path.join(directory, "comms.db"),
						readonly: true,
						disableWAL: true,
						busyTimeout: "100 millis",
					}),
				),
				Effect.scoped,
			);
		const withWrite = <A, E, R>(names: readonly string[], effect: Effect.Effect<A, E, R>) =>
			operationGate.withPermit(
				Effect.gen(function* () {
					const deadline = (yield* Clock.monotonicTimeNanos) + 1_000_000_000n;
					while (true) {
						const admitted = yield* channelGate.withPermit(
							Effect.gen(function* () {
								// The reservation gate makes the tombstone check and page journal publication indivisible
								// with respect to topic deletion; no sequenced topic mutation can reserve or publish between them.
								if ((yield* events.state).pending_id !== null) return null;
								yield* appRead(
									Effect.gen(function* () {
										const sql = yield* SqlClient.SqlClient;
										const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='topics'`;
										if (tables.length === 0) {
											const versions = yield* sql`PRAGMA user_version`.pipe(
												Effect.flatMap(
													Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int }))),
												),
											);
											// Boot-only stores exist before the editable app creates its domain schema.
											if (versions[0]?.user_version === 0) return;
											return yield* new PublicPagesUnavailable({});
										}
										for (const name of names) {
											const relative = name.slice("pages/".length).split("/").slice(0, -1).join("/");
											const deleted =
												yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${relative} OR substr(${relative},1,length(path)+1)=path||'/') LIMIT 1`;
											if (deleted.length) return yield* new SourceRejected({ code: "topic_deleted", path: name });
										}
									}),
								).pipe(
									Effect.mapError((error) =>
										error._tag === "SourceRejected" ? error : new PublicPagesUnavailable({}),
									),
								);
								return { value: yield* effect };
							}),
						);
						if (admitted !== null) return admitted.value;
						if ((yield* Clock.monotonicTimeNanos) >= deadline) return yield* new PublicPagesUnavailable({});
						// Allow the pending app outbox to append before checking again. Never retry publication.
						yield* Effect.sleep("10 millis");
					}
				}),
			);
		const check = (pathname: string) =>
			operationGate
				.withPermit(
					channelGate.withPermit(
						Effect.gen(function* () {
							if (!pathname.startsWith("/p/") || /%2f|%5c/i.test(pathname)) return null;
							const name = yield* Effect.try(() => decodeURIComponent(pathname.slice(3).replace(/\/$/, ""))).pipe(
								Effect.orElseSucceed(() => ""),
							);
							if (!pagePath(name)) return null;
							const root = path.join(yield* fs.realPath(directory), "pages");
							const resolve = (relative: string) =>
								Effect.gen(function* () {
									let target = root;
									for (const part of ["", ...relative.split("/")]) {
										if (part) target = path.join(target, part);
										if ((yield* fs.realPath(target)) !== target) return null;
									}
									const info = yield* fs.stat(target);
									return info.type === "File" || info.type === "Directory" ? { target, type: info.type } : null;
								});
							const target = yield* resolve(name).pipe(Effect.orElseSucceed(() => null));
							if (!target) return null;
							const topic = target.type === "Directory" ? name : name.split("/").slice(0, -1).join("/");
							if (!topicPath(topic)) return null;
							// No app reservation can begin or publish while this channel gate is held.
							// Refuse provisional metadata rather than making an unpublished grant visible.
							if ((yield* events.state).pending_id !== null) return yield* new PublicPagesUnavailable({});
							const rows = yield* Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								return yield* sql`SELECT path,meta,deleted_at FROM topics WHERE path=${topic} OR parent=${topic} OR substr(${topic},1,length(path)+1)=path||'/'`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
								);
							}).pipe(
								Effect.provide(
									SqliteClient.layer({
										filename: path.join(directory, "comms.db"),
										readonly: true,
										disableWAL: true,
										busyTimeout: "100 millis",
									}),
								),
								Effect.scoped,
							);
							if (
								rows.some((row) => row.deleted_at !== null && (row.path === topic || topic.startsWith(`${row.path}/`)))
							)
								return null;
							if (rows.find((row) => row.path === topic)?.meta.public !== true) return null;
							const children: string[] = [];
							if (target.type === "Directory") {
								const names = yield* fs.readDirectory(target.target);
								for (const index of ["index.md", "index.html"]) {
									if (!names.includes(index)) continue;
									const selected = yield* resolve(`${name}/${index}`).pipe(Effect.orElseSucceed(() => null));
									if (!selected || selected.type !== "File") return null;
									break;
								}
								for (const row of rows)
									if (
										row.path.startsWith(`${topic}/`) &&
										row.deleted_at === null &&
										row.meta.public === true &&
										topicPath(row.path)
									)
										children.push(row.path);
							}
							const marker = encodeURIComponent(yield* Schema.encodeEffect(Marker)({ path: name, children }));
							if (marker.length > 8192) return yield* new PublicPagesUnavailable({});
							return marker;
						}),
					),
				)
				.pipe(
					Effect.timeout("1 second"),
					Effect.catchCause(() => Effect.fail(new PublicPagesUnavailable({}))),
				);
		return { check, withWrite };
	});
/** Immutable request policy: only exact-topic metadata grants access; reads close before restore can acquire its gate. */
export class PublicPages extends Context.Service<PublicPages, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/PublicPages",
) {}
export const layer = (directory: string, operationGate: Semaphore.Semaphore, channelGate: Semaphore.Semaphore) =>
	Layer.effect(PublicPages, make(directory, operationGate, channelGate));
