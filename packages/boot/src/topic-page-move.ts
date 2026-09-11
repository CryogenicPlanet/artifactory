import { Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SourceFiles } from "./source-files.ts";
import { sourceIO, validSourcePath } from "./source-io.ts";
import { SourceRejected } from "./source-schema.ts";

const Move = Schema.Struct({
	id: Schema.String,
	from_path: Schema.String,
	to_path: Schema.String,
	agent: Schema.String,
	tree: Schema.NullOr(Schema.String),
	state: Schema.Literals(["prepared", "publishing", "published", "completed"]),
});

const make = (dataDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const sql = yield* SqlClient.SqlClient;
		const files = yield* SourceFiles;
		const io = yield* sourceIO(dataDirectory);
		const rejected = (
			name: string,
			code: "external_conflict" | "invalid_path" | "path_conflict" = "external_conflict",
		) => new SourceRejected({ code, path: name });
		const lookup = (id: string) =>
			sql`SELECT * FROM topic_page_moves WHERE id = ${id}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Move))),
				Effect.map((rows) => rows[0] ?? null),
			);
		const requireMove = (id: string) =>
			lookup(id).pipe(
				Effect.filterOrFail(
					(move) => move !== null,
					() => new SourceRejected({ code: "proposal_missing", path: id }),
				),
			);
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
					if (current === undefined) return yield* Effect.die("Missing page directory entry");
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
		return {
			// Legacy recovery calls this only after positive durable app-commit evidence.
			publish: (id: string) =>
				files.withPageMove(
					id,
					Effect.gen(function* () {
						const move = yield* requireMove(id);
						if (move.state === "completed") return;
						const before = yield* tree(move.from_path);
						const after = yield* tree(move.to_path);
						if (move.tree === null) {
							if (before !== null || after !== null) return yield* rejected(move.to_path);
						} else if (before === move.tree && after === null) {
							// Once publishing starts, discard is forbidden even if the process dies before rename.
							yield* sql`UPDATE topic_page_moves SET state = 'publishing' WHERE id = ${id}`;
							const target = yield* io.resolve(move.to_path, true, true);
							if (target.exists) return yield* rejected(move.to_path);
							const source = yield* io.resolve(move.from_path, false, true);
							yield* fs.rename(source.absolute, target.absolute);
						} else if (before !== null || after !== move.tree) {
							return yield* rejected(move.to_path);
						}
						// Replaying an already-renamed directory repeats both parent synchronization boundaries.
						yield* syncParents(move.from_path);
						yield* syncParents(move.to_path);
						yield* sql`UPDATE topic_page_moves SET state = 'published' WHERE id = ${id}`;
					}),
				),
			// Caller must first establish that the app transaction never committed.
			abort: (id: string) =>
				Effect.gen(function* () {
					// Preparation may have failed behind an unrelated source proposal without creating a page intent.
					if (!(yield* lookup(id))) return;
					yield* files.withPageMove(
						id,
						Effect.gen(function* () {
							const move = yield* lookup(id);
							if (!move) return;
							if (move.state !== "prepared") return yield* rejected(id);
							yield* sql`DELETE FROM topic_page_moves WHERE id = ${id}`;
						}),
					);
				}),
			// Keep ordinary publishers blocked until SQL visibility and historical event routing agree.
			finish: (id: string) =>
				Effect.gen(function* () {
					// Recovery also visits historical completed operations while a later move owns source admission.
					if ((yield* requireMove(id)).state === "completed") return;
					yield* files.withPageMove(
						id,
						Effect.gen(function* () {
							const move = yield* requireMove(id);
							if (move.state !== "published" && move.state !== "completed") return yield* rejected(id);
							yield* sql`UPDATE topic_page_moves SET state = 'completed' WHERE id = ${id}`;
						}),
					);
				}),
		};
	});

export class TopicPageMove extends Context.Service<TopicPageMove, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/TopicPageMove",
) {}
export const layer = (dataDirectory: string) => Layer.effect(TopicPageMove, make(dataDirectory));
