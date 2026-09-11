import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Crypto, Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fenceAppStore } from "./app-recovery.ts";
import { decodeRows } from "./decode-rows.ts";
import { Events, EventError } from "./events.ts";
import { sourceIO, validSourcePath } from "./source-io.ts";

const Move = Schema.Struct({
	id: Schema.String,
	from_path: Schema.String,
	to_path: Schema.String,
	instance: Schema.String,
	state: Schema.Literals(["prepared", "pages_published", "completed", "aborted"]),
	seq: Schema.NullOr(Schema.Int),
});
const Page = Schema.Struct({
	id: Schema.String,
	from_path: Schema.String,
	to_path: Schema.String,
	tree: Schema.NullOr(Schema.String),
	state: Schema.Literals(["prepared", "publishing", "published", "completed"]),
});
const refused = () => new EventError({ code: "topic_move_recovery_required" });
const legacyRows = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		const tables =
			yield* sql`SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('topic_moves','topic_page_moves')`;
		if (tables.length === 0) return null;
		if (tables.length !== 2) return yield* refused();
		const moves = yield* sql`SELECT * FROM topic_moves`.pipe(decodeRows(Move));
		const pages = yield* sql`SELECT * FROM topic_page_moves`.pipe(decodeRows(Page));
		if (pages.some((page) => !moves.some((move) => move.id === page.id))) return yield* refused();
		if (moves.filter((move) => move.state !== "completed" && move.state !== "aborted").length > 1)
			return yield* refused();
		return { moves, pages };
	}).pipe(Effect.mapError(refused));

/** Startup conflict inspection only; ordinary admission never consults retired metadata. */
export const legacyMovePending = (sql: SqlClient.SqlClient) =>
	legacyRows(sql).pipe(
		Effect.map(
			(rows) => rows !== null && rows.moves.some((move) => move.state !== "completed" && move.state !== "aborted"),
		),
	);

/** Call only after positive keeper closure, before any source or app recovery/publication. */
export const retireLegacyTopicMoves = (dataDirectory: string, filename: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const legacy = yield* legacyRows(sql);
		if (!legacy) return;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const io = yield* sourceIO(dataDirectory);
		const rejected = (_name: string, _code?: string) => refused();
		const digest = (value: Uint8Array) =>
			crypto.digest("SHA-256", value).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		// Retain identity and a hash of every entry, including empty directories. No page bytes are duplicated.
		// Historical page versions retain their original paths; the move does not rewrite immutable undo receipts.
		// These checks detect ordinary external edits; same-UID adversarial filesystem races remain out of scope.
		const tree = (name: string) =>
			Effect.gen(function* () {
				const root = yield* io.resolve(name, false, true);
				if (!root.exists) return null;
				if (root.type !== "Directory") return yield* rejected(name, "invalid_path");
				const pending = [name];
				const entries: string[] = [];
				while (pending.length > 0) {
					const current = pending.pop();
					if (current === undefined) return yield* rejected("pages");
					const target = yield* io.resolve(current, false, true);
					if (!target.exists) return yield* rejected(current);
					const info = yield* fs.stat(target.absolute);
					const identity = `${info.dev}:${Option.getOrNull(info.ino)}`;
					const content = target.type === "File" ? yield* digest(yield* fs.readFile(target.absolute)) : null;
					entries.push(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(
								Schema.Struct({
									path: Schema.String,
									type: Schema.NullOr(Schema.String),
									mode: Schema.Int,
									identity: Schema.String,
									sha: Schema.NullOr(Schema.String),
								}),
							),
						)({ path: current.slice(name.length), type: target.type, mode: info.mode & 0o777, identity, sha: content }),
					);
					if (target.type === "Directory") {
						for (const child of (yield* fs.readDirectory(target.absolute)).sort().reverse()) {
							const childName = `${current}/${child}`;
							if (!validSourcePath(childName)) return yield* rejected(childName, "invalid_path");
							pending.push(childName);
						}
					}
				}
				return yield* digest(new TextEncoder().encode(entries.join("\n")));
			});
		const syncParents = (name: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* fs.realPath(dataDirectory);
					let directory = path.dirname(path.join(root, name));
					while (true) {
						if (yield* fs.exists(directory)) yield* (yield* fs.open(directory)).sync;
						if (directory === root) break;
						directory = path.dirname(directory);
					}
				}),
			);

		const retire = sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`DROP TABLE topic_page_moves`;
				yield* sql`DROP TABLE topic_moves`;
			}),
		);
		// Validate terminal evidence without opening an app store another recovery owner may replace.
		const allocator = yield* events.state;
		for (const move of legacy.moves) {
			const page = legacy.pages.find((page) => page.id === move.id);
			if (page && (page.from_path !== `pages/${move.from_path}` || page.to_path !== `pages/${move.to_path}`))
				return yield* refused();
			if (move.state !== "completed" && move.state !== "aborted") continue;
			const receipts = yield* sql`SELECT state,attempt,from_seq,to_seq FROM event_batches WHERE id=${move.id}`.pipe(
				decodeRows(
					Schema.Struct({ state: Schema.String, attempt: Schema.String, from_seq: Schema.Int, to_seq: Schema.Int }),
				),
			);
			const receipt = receipts[0];
			if (allocator.pending_id === move.id) return yield* refused();
			if (move.state === "completed") {
				if (
					!page ||
					(page.state !== "completed" && page.state !== "published") ||
					receipt?.state !== "published" ||
					receipt.from_seq !== receipt.to_seq ||
					move.seq !== receipt.to_seq
				)
					return yield* refused();
			} else if ((page && page.state !== "prepared") || (receipt && receipt.state !== "aborted"))
				return yield* refused();
		}
		if (legacy.moves.every((move) => move.state === "completed" || move.state === "aborted")) return yield* retire;
		const { pending, evidence } = yield* fenceAppStore(filename, yield* crypto.randomUUIDv4);
		for (const move of legacy.moves) {
			const page = legacy.pages.find((page) => page.id === move.id);
			const validTopic = (name: string) =>
				name.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(name);
			if (
				!validTopic(move.from_path) ||
				!validTopic(move.to_path) ||
				move.from_path === move.to_path ||
				move.from_path.startsWith(`${move.to_path}/`) ||
				move.to_path.startsWith(`${move.from_path}/`)
			)
				return yield* refused();
			if (page && (page.from_path !== `pages/${move.from_path}` || page.to_path !== `pages/${move.to_path}`))
				return yield* refused();
			if (move.state === "completed" || move.state === "aborted") continue;
			const receipts = yield* sql`SELECT state,attempt,from_seq,to_seq FROM event_batches WHERE id=${move.id}`.pipe(
				decodeRows(
					Schema.Struct({ state: Schema.String, attempt: Schema.String, from_seq: Schema.Int, to_seq: Schema.Int }),
				),
			);
			const receipt = receipts[0];
			if (
				pending.pending_id === move.id &&
				(!pending.pending_attempt ||
					receipt?.state !== "pending" ||
					receipt.attempt !== pending.pending_attempt ||
					receipt.from_seq !== pending.pending_from ||
					receipt.to_seq !== pending.pending_to ||
					receipt.from_seq !== receipt.to_seq ||
					(move.seq !== null && move.seq !== receipt.to_seq))
			)
				return yield* refused();

			if (receipt?.state === "published") {
				// Prior preflight may have committed append but not its final legacy receipt.
				if (
					move.state !== "pages_published" ||
					pending.pending_id === move.id ||
					!page ||
					page.state !== "published" ||
					move.seq !== receipt.to_seq ||
					receipt.from_seq !== receipt.to_seq
				)
					return yield* refused();
				continue;
			}
			const batch = pending.pending_id === move.id ? evidence : null;
			if (!batch) {
				// Absence of a pending allocator row alone is not evidence that an app write never committed.
				const absent = yield* Effect.gen(function* () {
					const app = yield* SqlClient.SqlClient;
					return (
						(yield* app`SELECT 1 FROM mutation_batches WHERE id=${move.id} UNION ALL SELECT 1 FROM outbox WHERE transaction_id=${move.id} LIMIT 1`)
							.length === 0
					);
				}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped);
				if (
					!absent ||
					move.state !== "prepared" ||
					(page && page.state !== "prepared") ||
					(receipt && receipt.state !== "aborted" && pending.pending_id !== move.id)
				)
					return yield* refused();
				if (pending.pending_id === move.id && pending.pending_attempt)
					yield* events.abort(move.id, pending.pending_attempt);
				yield* sql`UPDATE topic_moves SET state='aborted' WHERE id=${move.id}`;
				continue;
			}
			const event = batch.events[0];
			const payload = yield* Schema.decodeUnknownEffect(Schema.Struct({ from: Schema.String, to: Schema.String }))(
				event?.payload,
			);
			if (
				!page ||
				page.state === "completed" ||
				batch.events.length !== 1 ||
				event?.type !== "topic.moved" ||
				event.instance !== move.instance ||
				event.topic !== move.to_path ||
				payload.from !== move.from_path ||
				payload.to !== move.to_path ||
				!pending.pending_attempt
			)
				return yield* refused();
			const before = yield* tree(page.from_path);
			const after = yield* tree(page.to_path);
			if (page.tree === null) {
				if (before !== null || after !== null) return yield* refused();
			} else if (before === page.tree && after === null) {
				yield* sql`UPDATE topic_page_moves SET state='publishing' WHERE id=${move.id}`;
				const target = yield* io.resolve(page.to_path, true, true);
				if (target.exists) return yield* refused();
				const source = yield* io.resolve(page.from_path, false, true);
				yield* fs.rename(source.absolute, target.absolute);
			} else if (before !== null || after !== page.tree) return yield* refused();
			yield* syncParents(page.from_path);
			yield* syncParents(page.to_path);
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`UPDATE topic_page_moves SET state='published' WHERE id=${move.id}`;
					yield* sql`UPDATE topic_moves SET state='pages_published',seq=${batch.to} WHERE id=${move.id}`;
				}),
			);
			// Legacy page publication is durable before event routing.
			yield* events.append(batch, pending.pending_attempt);
			// Legacy event publication is durable before retirement.
		}
		// Both tables are removed atomically only after every row has affirmative terminal evidence.
		yield* retire;
	}).pipe(Effect.mapError(refused));
