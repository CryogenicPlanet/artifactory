import type { RemoteStore } from "@comms/storage/store";
import { selectionText, TransferSelection } from "@comms/storage/store-transfer-schema";
import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { mysqlDatabaseProvision } from "./mysql-database-provision.ts";
import { postgresDatabaseProvision } from "./postgres-database-provision.ts";
import type { RemoteDatabaseRecord } from "./remote-database-journal.ts";
import { remoteNativeCopy } from "./remote-native-copy.ts";
import type { RemoteRuntime } from "./remote-runtime.ts";
import { transferDumpJournal } from "./transfer-dump-journal.ts";
import { TransferSafetyError } from "./transfer-safety-copy.ts";

const Receipt = Schema.Struct({
	version: Schema.Literal(1),
	selection: TransferSelection,
	files: Schema.Array(
		Schema.Struct({
			store: Schema.Literals(["boot", "app"]),
			resource_id: Schema.String,
			bytes: Schema.Int,
			hash: Schema.String,
		}),
	),
});
export type NativeTransferSafetyReceipt = typeof Receipt.Type;
const invalid = () => new TransferSafetyError({ code: "transfer_safety_copy_invalid" });

/** The CLI holds offline root ownership. Recover exact journaled dump principals before capture and
 * again before authority activation; no source SQL row or transfer intent is changed by this adapter. */
export const nativeTransferSafetyCopy = (options: {
	readonly selection: TransferSelection;
	readonly source: { readonly boot: RemoteStore; readonly app: RemoteStore };
	readonly runtime: RemoteRuntime;
	readonly budgetMs: number;
}) =>
	Effect.gen(function* () {
		if (!Number.isSafeInteger(options.budgetMs) || options.budgetMs <= 0) return yield* invalid();
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const journal = yield* transferDumpJournal(options.selection, options.source);
		const native = yield* remoteNativeCopy(options.runtime);
		const mysql = mysqlDatabaseProvision({
			created: () => Effect.fail(invalid()),
			owns: () => Effect.fail(invalid()),
		});
		const selected: Effect.Effect<
			Effect.Success<typeof postgresDatabaseProvision> | Effect.Success<typeof mysql>,
			Effect.Error<typeof postgresDatabaseProvision> | Effect.Error<typeof mysql>,
			SqlClient.SqlClient
		> = options.source.boot._tag === "postgres" ? postgresDatabaseProvision : mysql;
		const provision = yield* selected.pipe(Effect.provideService(SqlClient.SqlClient, options.runtime.bootSql));
		const withSource = <A, E>(store: RemoteStore, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
			store.database === options.source.boot.database
				? effect.pipe(Effect.provideService(SqlClient.SqlClient, options.runtime.bootSql))
				: options.runtime.withStore(store, effect);
		const sourceOf = (record: RemoteDatabaseRecord) => {
			if (record.database === options.source.boot.database) return Effect.succeed(options.source.boot);
			if (record.database === options.source.app.database) return Effect.succeed(options.source.app);
			return Effect.fail(invalid());
		};
		const finish = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				const credential = yield* journal.credential(record.id);
				// Closure includes historical keeper receipts. No root-principal exemption is introduced.
				yield* options.runtime.assertAccountClosed(record.id, credential);
				yield* journal.close(record.id);
				const closed = yield* journal.read(record.id);
				const source = yield* sourceOf(closed);
				yield* withSource(
					source,
					selected.pipe(Effect.flatMap((service) => service.revokeDump(closed))),
				);
				yield* provision.dropPrincipal(closed);
				yield* journal.finish(closed.id);
			});
		const recover = Effect.gen(function* () {
			for (const record of yield* journal.list) yield* finish(record);
		}).pipe(Effect.mapError(invalid));
		const hash = (bytes: Uint8Array) =>
			crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
		const artifact = (id: string) =>
			Effect.gen(function* () {
				const filename = yield* journal.pathFor(id);
				const stat = yield* fs.stat(filename);
				if (stat.type !== "File" || (yield* fs.realPath(filename)) !== filename || (stat.mode & 0o077) !== 0)
					return yield* invalid();
				const bytes = yield* fs.readFile(filename);
				return { bytes: bytes.byteLength, hash: yield* hash(bytes) };
			});
		const directory = path.join(options.selection.data_directory, "transfers", options.selection.transfer_id, "safety");
		const sync = (filename: string) => Effect.scoped(fs.open(filename).pipe(Effect.flatMap((file) => file.sync)));
		const verify = (filename: string) =>
			Effect.gen(function* () {
				if (
					path.dirname(path.dirname(filename)) !== directory ||
					path.basename(filename) !== "receipt.json" ||
					!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
						path.basename(path.dirname(filename)),
					) ||
					(yield* fs.realPath(filename)) !== filename ||
					(yield* fs.stat(filename)).type !== "File"
				)
					return yield* invalid();
				const receipt = yield* fs
					.readFileString(filename)
					.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Receipt))));
				if (
					selectionText(receipt.selection) !== selectionText(options.selection) ||
					receipt.files.length !== 2 ||
					receipt.files[0]?.store !== "boot" ||
					receipt.files[1]?.store !== "app" ||
					receipt.files[0].resource_id === receipt.files[1].resource_id
				)
					return yield* invalid();
				for (const file of receipt.files) {
					const record = yield* journal.read(file.resource_id);
					if (
						record.database !== options.source[file.store].database ||
						record.phase !== "closed" ||
						!(yield* journal.isFinished(record.id))
					)
						return yield* invalid();
					const actual = yield* artifact(record.id);
					if (actual.bytes !== file.bytes || actual.hash !== file.hash) return yield* invalid();
				}
				return receipt;
			}).pipe(Effect.mapError(invalid));
		const capture = Effect.gen(function* () {
			yield* recover;
			const files: Array<NativeTransferSafetyReceipt["files"][number]> = [];
			for (const store of ["boot", "app"] as const) {
				const record = yield* journal.allocate(store);
				const credential = yield* journal.credential(record.id);
				yield* provision.createPrincipal(record, credential);
				yield* withSource(options.source[store], selected.pipe(Effect.flatMap((service) => service.grantDump(record))));
				yield* journal.ready(record.id);
				const filename = yield* journal.pathFor(record.id);
				const copied = yield* native({
					operation: "dump",
					resourceId: record.id,
					store: credential,
					path: filename,
					budgetMs: options.budgetMs,
				});
				const expectedEngine = options.source[store]._tag === "postgres" ? "pg" : "mysql";
				if (copied.path !== filename || copied.engine !== expectedEngine) return yield* invalid();
				yield* finish(yield* journal.read(record.id));
				const captured = yield* artifact(record.id);
				if (captured.bytes !== copied.bytes) return yield* invalid();
				files.push({ store, resource_id: record.id, ...captured });
			}
			// Journal construction has validated each ancestor; this sibling is still checked before writes.
			if (!(yield* fs.readDirectory(path.dirname(directory))).includes(path.basename(directory)))
				yield* fs.makeDirectory(directory, { mode: 0o700 });
			if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).type !== "Directory")
				return yield* invalid();
			const destination = path.join(directory, yield* crypto.randomUUIDv4);
			yield* fs.makeDirectory(destination, { mode: 0o700 });
			const filename = path.join(destination, "receipt.json");
			const receipt: NativeTransferSafetyReceipt = { version: 1, selection: options.selection, files };
			yield* fs.writeFileString(filename, yield* Schema.encodeEffect(Schema.fromJsonString(Receipt))(receipt), {
				flag: "wx",
				mode: 0o600,
			});
			for (const name of [filename, destination, directory, path.dirname(directory)]) yield* sync(name);
			yield* verify(filename);
			return { path: filename, receipt };
		}).pipe(Effect.mapError(invalid));
		return { capture, verify, recover };
	});
