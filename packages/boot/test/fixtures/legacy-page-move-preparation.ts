import { Crypto, Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SourceFiles } from "../../src/source-files.ts";
import { sourceIO, validSourcePath } from "../../src/source-io.ts";
import { SourceRejected } from "../../src/source-schema.ts";

const Move = Schema.Struct({
	id: Schema.String,
	from_path: Schema.String,
	to_path: Schema.String,
	agent: Schema.String,
	tree: Schema.NullOr(Schema.String),
	state: Schema.Literals(["prepared", "publishing", "published", "completed"]),
});

// Reproduce the legacy durable intent format so recovery tests do not retain a production constructor.
export const legacyPageMovePreparation = (dataDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
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
		const digest = (value: Uint8Array) =>
			crypto.digest("SHA-256", value).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		// Retain identity and a hash of every entry, including empty directories. No page bytes are duplicated.
		// Historical page versions retain their original paths; the move does not rewrite immutable undo receipts.
		// These checks detect ordinary external edits; same-UID adversarial filesystem races remain out of scope.
		const tree = (name: string, movedTo?: string) =>
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
					if (
						target.type === "Directory" &&
						movedTo !== undefined &&
						`${movedTo}${current.slice(name.length)}`.length > 206
					)
						return yield* rejected(current, "invalid_path");
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
		return (id: string, from: string, to: string, agent: string) =>
			files.withPageMove(
				id,
				Effect.gen(function* () {
					const fromName = `pages/${from}`;
					const toName = `pages/${to}`;
					if (!validSourcePath(fromName) || !validSourcePath(toName) || from.length > 200 || to.length > 200)
						return yield* rejected(fromName, "invalid_path");
					if (from === to || from.startsWith(`${to}/`) || to.startsWith(`${from}/`))
						return yield* rejected(toName, "path_conflict");
					const saved = yield* lookup(id);
					if (saved) {
						if (saved.from_path !== fromName || saved.to_path !== toName || saved.agent !== agent)
							return yield* new SourceRejected({ code: "idempotency_conflict", path: id });
						return { page_source: saved.tree !== null };
					}
					if ((yield* io.resolve(toName, false, true)).exists) return yield* rejected(toName, "path_conflict");
					const captured = yield* tree(fromName, toName);
					yield* sql`INSERT INTO topic_page_moves (id,from_path,to_path,agent,tree,state) VALUES (${id},${fromName},${toName},${agent},${captured},'prepared')`;
					return { page_source: captured !== null };
				}),
			);
	});
