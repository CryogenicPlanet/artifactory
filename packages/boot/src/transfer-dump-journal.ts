import type { RemoteStore } from "@comms/storage/store";
import { selectionText, TransferSelection, validateTransferSelection } from "@comms/storage/store-transfer-schema";
import { Crypto, Effect, FileSystem, Path, Redacted, Schema, Semaphore } from "effect";
import { RemoteDatabaseError, type RemoteDatabaseRecord } from "./remote-database-journal.ts";

export const TransferDumpRecord = Schema.Struct({
	selection: TransferSelection,
	store: Schema.Literals(["boot", "app"]),
	id: Schema.String,
	phase: Schema.Literals(["allocated", "ready", "closed"]),
	finished: Schema.Boolean,
	password: Schema.NullOr(Schema.String),
});
const Encoded = Schema.fromJsonString(TransferDumpRecord);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new RemoteDatabaseError({ code: "remote_database_invalid" });

/** Only the offline command holding the data-root lock may use this journal.
 * The complete secret and intent are fsynced before allocation returns, hence before CREATE.
 * Interrupted .pending files cannot authorize a principal and are retained for diagnosis.
 * Closing requires the caller's keeper/session absence proof; finish follows successful revoke/drop. */
export const transferDumpJournal = (selection: TransferSelection, source: { boot: RemoteStore; app: RemoteStore }) =>
	Effect.gen(function* () {
		yield* validateTransferSelection(selection);
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const gate = yield* Semaphore.make(1);
		const root = selection.data_directory;
		if ((yield* fs.realPath(root)) !== root) return yield* invalid();
		const urls = yield* Effect.forEach(["boot", "app"] as const, (which) =>
			Effect.try({ try: () => new URL(Redacted.value(source[which].url)), catch: invalid }),
		);
		for (const [index, which] of (["boot", "app"] as const).entries()) {
			const url = urls[index];
			const store = source[which];
			if (
				!url ||
				(store._tag === "postgres" ? "pg" : "mysql") !== selection.source.engine ||
				store.database !== selection.source[which] ||
				`${url.hostname}:${url.port || (store._tag === "postgres" ? "5432" : "3306")}` !== selection.source.endpoint
			)
				return yield* invalid();
		}
		const directory = path.join(root, "transfers", selection.transfer_id, "backup-resources");
		const sync = (file: string) => Effect.scoped(fs.open(file).pipe(Effect.flatMap((handle) => handle.sync)));
		const checked = (file: string, type: "File" | "Directory") =>
			Effect.gen(function* () {
				const stat = yield* fs.stat(file);
				if ((yield* fs.realPath(file)) !== file || stat.type !== type || (stat.mode & 0o077) !== 0)
					return yield* invalid();
			});
		// Validate each ancestor before creating its child, including dangling symlinks.
		for (const parent of [path.join(root, "transfers"), path.dirname(directory), directory]) {
			if (!(yield* fs.readDirectory(path.dirname(parent))).includes(path.basename(parent))) {
				yield* fs.makeDirectory(parent, { mode: 0o700 });
				yield* sync(path.dirname(parent));
			}
			yield* checked(parent, "Directory");
			yield* sync(parent);
			yield* sync(path.dirname(parent));
		}
		const filename = (id: string) => path.join(directory, `${id}.json`);
		const validate = (saved: typeof TransferDumpRecord.Type, id: string) => {
			if (
				!uuid.test(id) ||
				saved.id !== id ||
				selectionText(saved.selection) !== selectionText(selection) ||
				(saved.finished
					? saved.phase !== "closed" || saved.password !== null
					: saved.password === null || !/^[a-f0-9]{64}$/.test(saved.password))
			)
				return Effect.fail(invalid());
			return Effect.succeed(saved);
		};
		const load = (id: string) =>
			Effect.gen(function* () {
				if (!uuid.test(id)) return yield* invalid();
				yield* checked(directory, "Directory");
				yield* checked(filename(id), "File");
				// A prior rename may have completed just before interruption of directory fsync.
				yield* sync(filename(id));
				yield* sync(directory);
				return yield* fs.readFileString(filename(id)).pipe(
					Effect.flatMap(Schema.decodeEffect(Encoded)),
					Effect.mapError(invalid),
					Effect.flatMap((saved) => validate(saved, id)),
				);
			});
		const record = (saved: typeof TransferDumpRecord.Type): RemoteDatabaseRecord => ({
			id: saved.id,
			kind: "dump",
			endpoint: `${source[saved.store]._tag}://${selection.source.endpoint}`,
			database: selection.source[saved.store],
			principal: `comms_t_${saved.id.replaceAll("-", "").slice(0, 24)}`,
			phase: saved.phase,
		});
		const write = (saved: typeof TransferDumpRecord.Type) =>
			Effect.gen(function* () {
				yield* checked(directory, "Directory");
				const pending = path.join(directory, `${saved.id}.${yield* crypto.randomUUIDv4}.pending`);
				yield* fs.writeFileString(pending, yield* Schema.encodeEffect(Encoded)(saved), { flag: "wx", mode: 0o600 });
				yield* sync(pending);
				yield* fs.rename(pending, filename(saved.id));
				yield* sync(directory);
			});
		const read = (id: string) => load(id).pipe(Effect.map(record));
		const allocate = (store: "boot" | "app") =>
			gate.withPermit(
				Effect.gen(function* () {
					const id = yield* crypto.randomUUIDv4;
					const saved: typeof TransferDumpRecord.Type = {
						selection,
						store,
						id,
						phase: "allocated",
						finished: false,
						password: Buffer.from(yield* crypto.randomBytes(32)).toString("hex"),
					};
					if (yield* fs.exists(filename(id))) return yield* invalid();
					yield* write(saved);
					return record(saved);
				}),
			);
		const list = gate.withPermit(
			Effect.gen(function* () {
				yield* checked(directory, "Directory");
				const entries = yield* fs.readDirectory(directory);
				const records: RemoteDatabaseRecord[] = [];
				for (const entry of entries) {
					yield* checked(path.join(directory, entry), "File");
					const parts = entry.split(".");
					if (
						parts.length === 3 &&
						parts[0] &&
						parts[1] &&
						uuid.test(parts[0]) &&
						uuid.test(parts[1]) &&
						parts[2] === "pending"
					)
						continue;
					const id = parts[0];
					if (!id || !uuid.test(id) || parts.length !== 2 || !["json", "dump"].includes(parts[1] ?? ""))
						return yield* invalid();
					const saved = yield* load(id);
					if (parts[1] === "json" && !saved.finished) records.push(record(saved));
				}
				return records;
			}),
		);
		const credential = (id: string) =>
			Effect.gen(function* () {
				const saved = yield* load(id);
				if (saved.finished || saved.password === null) return yield* invalid();
				const store = source[saved.store];
				const url = yield* Effect.try({ try: () => new URL(Redacted.value(store.url)), catch: invalid });
				url.username = record(saved).principal;
				url.password = saved.password;
				url.pathname = `/${encodeURIComponent(store.database)}`;
				return { ...store, url: Redacted.make(url.href) };
			});
		const transition = (id: string, next: "ready" | "closed" | "finished") =>
			gate.withPermit(
				Effect.gen(function* () {
					const saved = yield* load(id);
					if (next === "finished") {
						if (saved.phase !== "closed") return yield* invalid();
						yield* write({ ...saved, finished: true, password: null });
					} else {
						if (saved.finished || (next === "ready" && saved.phase !== "allocated")) return yield* invalid();
						yield* write({ ...saved, phase: next });
					}
					return yield* read(id);
				}),
			);
		const pathFor = (id: string) => read(id).pipe(Effect.map(() => path.join(directory, `${id}.dump`)));
		return {
			isFinished: (id: string) => load(id).pipe(Effect.map((saved) => saved.finished)),
			allocate,
			read,
			list,
			credential,
			pathFor,
			ready: (id: string) => transition(id, "ready"),
			close: (id: string) => transition(id, "closed"),
			finish: (id: string) => transition(id, "finished"),
		};
	});
