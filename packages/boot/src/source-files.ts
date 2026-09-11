import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { EditAuthority, EditLock, EditRejected, type Ownership } from "./edit-lock.ts";
import { generationSource } from "./generation-source.ts";
import { sourceIO, validSourcePath } from "./source-io.ts";
import { sourceJournal, type UndoSelection } from "./source-journal.ts";
import type { TreeEntry } from "./source-tree-publication.ts";
import { SourceRejected, type Change, type Write } from "./source-schema.ts";
import { copySource } from "./snapshots.ts";

interface Proposal {
	readonly id: string;
	readonly owner: Ownership | null;
	readonly agent: string;
	readonly changes: readonly Change[];
	readonly tree?: boolean;
}
export interface Anchor {
	readonly old_string: string;
	readonly new_string: string;
	readonly replace_all?: boolean;
}

const make = (dataDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const lock = yield* EditLock;
		const sql = yield* SqlClient.SqlClient;
		const io = yield* sourceIO(dataDirectory);
		const journal = yield* sourceJournal(io);
		const semaphore = yield* Semaphore.make(1);
		const prepared = yield* Ref.make<Proposal | null>(null);
		const pageMoveReady = (id?: string) =>
			sql`SELECT id FROM topic_page_moves WHERE state != 'completed'`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))),
				Effect.flatMap((rows) => {
					const pending = rows[0];
					return pending && pending.id !== id
						? Effect.fail(new SourceRejected({ code: "publication_pending", path: pending.id }))
						: Effect.void;
				}),
			);
		const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			semaphore.withPermit(Effect.andThen(journal.ready, Effect.andThen(pageMoveReady(), effect)));
		const validate = (name: string) =>
			validSourcePath(name) ? Effect.void : Effect.fail(new SourceRejected({ code: "invalid_path", path: name }));
		const read = Effect.fn("SourceFiles.read")(function* (name: string, owner?: Ownership) {
			yield* validate(name);
			const base = yield* io.read(name);
			if (!owner || !name.startsWith("app/")) return base;
			const overlay = yield* lock.overlay(owner);
			const staged = overlay.value.find((file) => file.path === name);
			return staged ? yield* io.image(staged.content, staged.mode ?? base.mode) : base;
		});
		const capture = Effect.fn("SourceFiles.capture")(function* (writes: readonly Write[]) {
			const ordered = [...writes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			const changes: Change[] = [];
			for (const [index, write] of ordered.entries()) {
				yield* validate(write.path);
				if (
					ordered.some(
						(other, otherIndex) =>
							otherIndex !== index && (other.path === write.path || write.path.startsWith(`${other.path}/`)),
					)
				)
					return yield* new SourceRejected({ code: "path_conflict", path: write.path });
				const before = yield* io.read(write.path);
				if (write.mode !== undefined && (!Number.isSafeInteger(write.mode) || write.mode < 0 || write.mode > 0o777))
					return yield* new SourceRejected({ code: "invalid_path", path: write.path });
				changes.push({
					path: write.path,
					before,
					desired: yield* io.image(write.content?.slice() ?? null, write.mode ?? before.mode),
				});
			}
			if (ordered.length > 1)
				yield* Effect.scoped(
					Effect.gen(function* () {
						// Let this filesystem decide aliasing, including names that are all absent in the live tree.
						const directory = yield* fs.makeTempDirectoryScoped({ directory: dataDirectory, prefix: ".paths-" });
						const names = yield* sourceIO(directory);
						for (const write of ordered) {
							const target = yield* names.resolve(write.path, true);
							yield* fs.writeFileString(target.absolute, "", { flag: "wx" });
						}
					}).pipe(
						Effect.catchTag("SourceRejected", (error) =>
							Effect.fail(new SourceRejected({ code: "path_conflict", path: error.path })),
						),
					),
				);
			return changes;
		});
		const available = Effect.gen(function* () {
			if (yield* Ref.get(prepared)) return yield* new SourceRejected({ code: "publication_pending", path: "prepared" });
		});
		const proposal = (id: string) =>
			Effect.gen(function* () {
				const value = yield* Ref.get(prepared);
				if (!value || value.id !== id) return yield* new SourceRejected({ code: "proposal_missing", path: id });
				return value;
			});
		const pinned = (owner: Ownership) =>
			Effect.gen(function* () {
				yield* lock.overlay(owner);
				const current = (yield* lock.inspect).value;
				if (!current?.cutover_in_flight)
					return yield* new EditRejected({ code: "not_pinned", holder: current, transitions: [] });
			});
		const prepare = (owner: Ownership) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					yield* available;
					const holder = (yield* lock.pin(owner)).value;
					return yield* Effect.gen(function* () {
						const changes = yield* restore(
							lock.overlay(owner).pipe(
								Effect.flatMap((result) =>
									capture(
										result.value.map((file) => ({
											path: file.path,
											content: file.content,
											...(file.mode === null ? {} : { mode: file.mode }),
										})),
									),
								),
							),
						);
						const id = yield* crypto.randomUUIDv4;
						yield* Ref.set(prepared, { id, owner, agent: holder.agent, changes });
						return id;
					}).pipe(Effect.onError(() => lock.finish(owner, { succeeded: false }).pipe(Effect.orDie)));
				}),
			);

		const prepareTree = (owner: Ownership, before: readonly TreeEntry[], desired: readonly TreeEntry[]) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const prior = new Map(before.map((entry) => [entry.path, entry.image]));
					const next = new Map(desired.map((entry) => [entry.path, entry.image]));
					const absent = { content: null, sha: null, mode: null };
					const changes = [...new Set([...prior.keys(), ...next.keys()])].sort().map((name) => ({
						path: name,
						before: prior.get(name) ?? absent,
						desired: next.get(name) ?? absent,
					}));
					const id = yield* crypto.randomUUIDv4;
					const holder = (yield* lock.pin(owner)).value;
					yield* Ref.set(prepared, { id, owner, agent: holder.agent, changes, tree: true });
					return id;
				}),
			);

		const preparePages = (agent: string, writes: readonly Write[]) =>
			Effect.gen(function* () {
				yield* available;
				for (const write of writes)
					if (!write.path.startsWith("pages/"))
						return yield* new SourceRejected({ code: "invalid_path", path: write.path });
				const changes = yield* capture(writes);
				const id = yield* crypto.randomUUIDv4;
				yield* Ref.set(prepared, { id, owner: null, agent, changes });
				return id;
			});

		return {
			// The durable page intent keeps this admission closed between coordinator calls and after restart.
			withPageMove: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
				semaphore.withPermit(
					Effect.andThen(journal.ready, Effect.andThen(available, Effect.andThen(pageMoveReady(id), effect))),
				),
			read: (name: string, owner?: Ownership) => guard(read(name, owner)),
			browse: (name: string, owner?: Ownership) =>
				guard(
					Effect.gen(function* () {
						const committed = yield* io.list(name);
						const items = new Map((committed ?? []).map((item) => [item.name, item]));
						if (owner && (name === "app" || name.startsWith("app/"))) {
							for (const file of (yield* lock.overlay(owner)).value) {
								if (!file.path.startsWith(`${name}/`)) continue;
								yield* io.resolve(file.path);
								const relative = file.path.slice(name.length + 1);
								const child = relative.split("/")[0];
								if (child === undefined) continue;
								if (file.content !== null)
									items.set(child, { name: child, type: relative.includes("/") ? "directory" : "file" });
								else if (!relative.includes("/")) items.delete(child);
							}
						}
						if (committed === null && items.size === 0) return null;
						return [...items.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
					}),
				),
			history: (name: string) => guard(Effect.andThen(validate(name), journal.history(name))),
			previous: (batch: string) => guard(journal.previous(batch)),
			stage: (owner: Ownership, name: string, content: Uint8Array | null, baseVersion?: string | null) =>
				guard(
					Effect.gen(function* () {
						const current = yield* read(name, owner);
						if (baseVersion !== undefined && current.sha !== baseVersion)
							return yield* new SourceRejected({ code: "stale_base", path: name });
						return yield* lock.stage(owner, name, content, current.mode);
					}),
				),
			edit: (owner: Ownership, name: string, edits: readonly Anchor[], baseVersion?: string | null) =>
				guard(
					Effect.gen(function* () {
						const current = yield* read(name, owner);
						if (baseVersion !== undefined && current.sha !== baseVersion)
							return yield* new SourceRejected({ code: "stale_base", path: name });
						let text = yield* Effect.try({
							try: () => new TextDecoder("utf-8", { fatal: true }).decode(current.content ?? new Uint8Array()),
							catch: () => new SourceRejected({ code: "invalid_text", path: name }),
						});
						for (const edit of edits) {
							if (edit.old_string === "" || !text.includes(edit.old_string))
								return yield* new SourceRejected({ code: "anchor_not_found", path: name });
							const first = text.indexOf(edit.old_string);
							if (!edit.replace_all && text.indexOf(edit.old_string, first + 1) !== -1)
								return yield* new SourceRejected({ code: "ambiguous_anchor", path: name });
							text = edit.replace_all
								? text.split(edit.old_string).join(edit.new_string)
								: text.slice(0, first) + edit.new_string + text.slice(first + edit.old_string.length);
						}
						return yield* lock.stage(owner, name, new TextEncoder().encode(text), current.mode);
					}),
				),
			proposalPaths: (id: string) =>
				guard(Effect.map(proposal(id), (value) => value.changes.map((change) => change.path))),
			prepare: (owner: Ownership) => guard(prepare(owner)),
			prepareGeneration: (owner: Ownership, selection: UndoSelection) =>
				guard(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							yield* available;
							if ((yield* lock.overlay(owner)).value.length > 0)
								return yield* new EditRejected({
									code: "staging_not_empty",
									holder: (yield* lock.inspect).value,
									transitions: [],
								});
							const selected = yield* journal.selectUndo(selection);
							if (selected.generation === undefined)
								return yield* new SourceRejected({ code: "generation_unavailable", path: "selection" });
							const directory = yield* generationSource(dataDirectory, selected.generation).pipe(
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.provideService(Crypto.Crypto, crypto),
								Effect.provideService(FileSystem.FileSystem, fs),
								Effect.provideService(Path.Path, path),
							);
							const before = yield* restore(io.inventory());
							const desired = yield* restore(
								io
									.inventory(directory)
									.pipe(
										Effect.catchTag("SourceRejected", (error) =>
											Effect.fail(new SourceRejected({ code: "invalid_path", path: error.path })),
										),
									),
							);
							return yield* prepareTree(owner, before, desired);
						}),
					),
				),
			prepareUndo: (owner: Ownership, selection: string | UndoSelection) =>
				guard(
					Effect.gen(function* () {
						yield* available;
						const overlay = yield* lock.overlay(owner);
						if (overlay.value.length > 0)
							return yield* new EditRejected({
								code: "staging_not_empty",
								holder: (yield* lock.inspect).value,
								transitions: [],
							});
						const input = typeof selection === "string" ? { batch: selection } : selection;
						if (input.path !== undefined) yield* validate(input.path);
						const tree = yield* journal.treeUndo(input);
						if (tree !== null) {
							const before = yield* io.inventory();
							const retained = before.filter(
								(entry) => !tree.roots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)),
							);
							return yield* prepareTree(owner, before, [...retained, ...tree.entries]);
						}
						const writes = yield* journal.undo(input);
						if (writes.some((write) => !write.path.startsWith("app/")))
							return yield* new SourceRejected({
								code: "invalid_path",
								path: writes.find((write) => !write.path.startsWith("app/"))?.path ?? "",
							});
						yield* capture(writes);
						yield* lock.stageBatch(owner, writes, { requireEmpty: true });
						return yield* prepare(owner);
					}),
				),
			// Trusted page publisher only. App publication requires a pin, via overlay or retained undo history.
			preparePages: (agent: string, writes: readonly Write[]) => guard(preparePages(agent, writes)),
			preparePageUndo: (agent: string, selection: UndoSelection) =>
				guard(
					Effect.gen(function* () {
						if (selection.path !== undefined) yield* validate(selection.path);
						if (!(yield* journal.targetsPages(selection))) return null;
						yield* available;
						return yield* preparePages(agent, yield* journal.undo(selection));
					}),
				),
			discard: (id: string) =>
				guard(
					Effect.uninterruptible(
						Effect.gen(function* () {
							if (!(yield* Ref.get(prepared))) return;
							const value = yield* proposal(id);
							if (value.owner) yield* lock.finish(value.owner, { succeeded: false });
							yield* Ref.set(prepared, null);
						}),
					),
				),
			// Must follow successful rehearsal. The caller alone finalizes the lock after accepted cutover.
			publish: (id: string) =>
				guard(
					Effect.gen(function* () {
						const value = yield* proposal(id);
						if (value.owner) yield* pinned(value.owner);
						yield* Effect.uninterruptible(
							Effect.gen(function* () {
								yield* sql.withTransaction(
									Effect.gen(function* () {
										const authority = !value.owner
											? Option.getOrNull(yield* Effect.serviceOption(EditAuthority))
											: null;
										if (authority) {
											const now = (yield* DateTime.nowAsDate).getTime();
											const active =
												authority.kind === "human"
													? yield* sql`SELECT id FROM sessions WHERE id=${authority.id} AND expires_at>${now}`
													: yield* sql`SELECT id FROM tokens WHERE family=${authority.id} AND kind='access' AND revoked_at IS NULL LIMIT 1`;
											if (authority.expiresAt <= now || active.length === 0)
												return yield* new EditRejected({ code: "authority_expired", holder: null, transitions: [] });
										}
										yield* journal.begin(
											{
												id,
												lock_id: value.owner?.id ?? null,
												agent: value.agent,
												at: (yield* DateTime.nowAsDate).getTime(),
												state: "publishing",
											},
											value.changes,
										);
									}),
								);
								yield* Ref.set(prepared, null);
							}),
						);
						return yield* journal.recover;
					}),
				),
			recover: semaphore.withPermit(Effect.andThen(pageMoveReady(), journal.recover)),
			// All new source snapshots share this admission boundary; saved-good snapshots require no editable IO.
			withCommitted: guard,
			materialize: (id: string) =>
				guard(
					Effect.gen(function* () {
						const value = yield* proposal(id);
						if (!value.owner) return yield* new SourceRejected({ code: "invalid_path", path: "pages" });
						yield* pinned(value.owner);
						const directory = yield* fs.makeTempDirectoryScoped({ directory: dataDirectory, prefix: ".proposal-" });
						if (value.tree) {
							const target = yield* sourceIO(directory);
							yield* target.publishTree(
								value.changes.map((change) => ({ ...change, before: { content: null, sha: null, mode: null } })),
								id,
							);
							return directory;
						}
						const source = path.join(yield* fs.realPath(dataDirectory), "app");
						if ((yield* fs.realPath(source)) !== source)
							return yield* new SourceRejected({ code: "invalid_path", path: "app" });
						yield* copySource(source, path.join(directory, "app"));
						const target = yield* sourceIO(directory);
						for (const [index, change] of value.changes.entries())
							yield* target.replace(change.path, change.desired, `${id}-${index}`);
						return directory;
					}),
				),
		};
	});
export class SourceFiles extends Context.Service<SourceFiles, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/SourceFiles",
) {}
export const layer = (dataDirectory: string) => Layer.effect(SourceFiles, make(dataDirectory));
