import { Effect, FileSystem, Path, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { KernelError } from "./boot-channel.ts";

export const PageContinuation = Schema.Struct({
	seq: Schema.Int,
	from_path: Schema.String,
	to_path: Schema.String,
	marker: Schema.String,
	completed: Schema.Int,
});
export type PageContinuation = typeof PageContinuation.Type;
export const pendingPageMove = (
	sql: SqlClient,
	name: string,
) => sql`SELECT seq FROM topic_page_continuations WHERE completed=0 AND
 (from_path=${name} OR to_path=${name} OR substr(${name},1,length(from_path)+1)=from_path||'/' OR substr(${name},1,length(to_path)+1)=to_path||'/'
 OR substr(from_path,1,length(${name})+1)=${name}||'/' OR substr(to_path,1,length(${name})+1)=${name}||'/') LIMIT 1`;

/** Only called while a shared mutation reservation excludes boot's page journal. */
export const makePageContinuation = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const conflict = () => new KernelError({ code: "topic_move_evidence_invalid" });
		const resolve = (name: string, create = false) =>
			Effect.gen(function* () {
				const root = path.join(yield* fs.realPath(path.dirname(directory)), path.basename(directory));
				let target = root;
				for (const part of ["", ...name.split("/")]) {
					if (part) target = path.join(target, part);
					const present = (yield* fs.readDirectory(path.dirname(target))).includes(path.basename(target));
					if (!present) {
						if (!create) return null;
						yield* fs.makeDirectory(target);
						yield* sync(path.dirname(target));
					}
					if ((yield* fs.realPath(target)) !== target || (yield* fs.stat(target)).type !== "Directory")
						return yield* conflict();
				}
				return target;
			});
		const sync = (name: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* (yield* fs.open(name)).sync;
				}),
			);
		const markerPath = (root: string, marker: string) => path.join(root, `.comms-move-${marker}`);
		const marked = (root: string | null, marker: string) =>
			Effect.gen(function* () {
				if (!root) return false;
				const name = markerPath(root, marker);
				if (!(yield* fs.exists(name))) return false;
				if ((yield* fs.realPath(name)) !== name || (yield* fs.stat(name)).type !== "File") return yield* conflict();
				return (yield* fs.readFileString(name)) === marker;
			});
		return {
			prepare: (from: string, to: string, marker: string) =>
				Effect.gen(function* () {
					if (yield* resolve(to)) return yield* new KernelError({ code: "topic_exists" });
					const source = yield* resolve(from);
					if (!source) return false;
					yield* Effect.scoped(
						Effect.gen(function* () {
							const file = yield* fs.open(markerPath(source, marker), { flag: "wx" });
							yield* file.writeAll(new TextEncoder().encode(marker));
							yield* file.sync;
						}),
					);
					yield* sync(source);
					return true;
				}),
			finish: (move: PageContinuation) =>
				Effect.gen(function* () {
					const destination = yield* resolve(move.to_path);
					// A later write may have recreated the old name; never inspect or consume it after positive destination evidence.
					if (yield* marked(destination, move.marker)) {
						if (!destination) return yield* conflict();
						yield* sync(path.dirname(path.join(directory, move.from_path)));
						yield* sync(path.dirname(destination));
						return;
					}
					if (destination) return yield* conflict();
					const source = yield* resolve(move.from_path);
					if (!source || !(yield* marked(source, move.marker))) return yield* conflict();
					const parent = move.to_path.split("/").slice(0, -1).join("/");
					const targetParent = yield* resolve(parent, true);
					if (!targetParent) return yield* conflict();
					yield* fs.rename(source, path.join(targetParent, move.to_path.split("/").at(-1) ?? ""));
					yield* sync(path.dirname(source));
					yield* sync(targetParent);
				}),
		};
	});
export type PageMoveIO = Effect.Success<ReturnType<typeof makePageContinuation>>;
