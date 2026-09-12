import { childStore, connectionOf, parseDescriptor, StoreError } from "@comms/storage/store";
import { TransferFileJournal, validateTransferPreparation } from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { ChildConfiguration } from "./keeper-configuration.ts";

const endpoint = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
const invalid = () => new StoreError({ code: "store_descriptor_mismatch" });

/** Root keeper independently binds its offline child to the private, unfinished target preparation. */
export const authorizeTransferApp = (config: typeof ChildConfiguration.Type) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const id = config.env.TRANSFER_ID;
		if (
			!id ||
			!/^[a-f0-9]{64}(?![\s\S])/.test(config.attempt) ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(id) ||
			config.env.STATE !== "transfer" ||
			config.entry !== `${config.cwd}/transfer-app-worker.ts` ||
			config.env.TRANSFER_APP_RESULT !== `/data/rehearsals/transfer-${config.attempt}/result.json`
		)
			return yield* invalid();
		const root = `/data/transfers/${id}`;
		const filename = `${root}/journal.json`;
		for (const name of ["/data/transfers", root, filename]) {
			const stat = yield* fs.stat(name);
			if (
				(yield* fs.realPath(name)) !== name ||
				!Option.contains(stat.uid, 1000) ||
				(stat.mode & 0o077) !== 0 ||
				stat.type !== (name === filename ? "File" : "Directory") ||
				(name === filename && (stat.size > 32768n || !Option.contains(stat.nlink, 1)))
			)
				return yield* invalid();
		}
		const journal = yield* fs
			.readFileString(filename)
			.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TransferFileJournal))));
		if (journal.phase !== "preparing") return yield* invalid();
		const preparation = yield* validateTransferPreparation(journal);
		if (
			preparation.sentinel !== "ready" ||
			preparation.epoch !== config.env.WRITER_EPOCH ||
			preparation.selection.transfer_id !== id ||
			preparation.selection.data_directory !== "/data"
		)
			return yield* invalid();
		const target = preparation.selection.target;
		const store = yield* parseDescriptor(config.env.APP_STORE ?? "");
		if (store._tag === "file") {
			if (
				config.remote ||
				target.engine !== "sqlite" ||
				!["/data/store/comms.db", `/data/rehearsals/transfer-check-${id}/comms.db`].includes(target.app)
			)
				return yield* invalid();
			const selected = yield* childStore(config.env.APP_STORE, config.env.APP_DATABASE);
			if (selected.filename !== target.app) return yield* invalid();
		} else {
			if (
				!config.remote ||
				config.remote.dataDirectory !== `${root}/target-owners` ||
				config.env.APP_DATABASE !== undefined
			)
				return yield* invalid();
			const boot = yield* parseDescriptor(config.remote.bootStore);
			if (boot._tag === "file") return yield* invalid();
			const appConnection = yield* connectionOf(store, config.remote.tls);
			const bootConnection = yield* connectionOf(boot, config.remote.tls);
			if (
				appConnection.engine !== target.engine ||
				bootConnection.engine !== target.engine ||
				endpoint(appConnection.host, appConnection.port) !== target.endpoint ||
				endpoint(bootConnection.host, bootConnection.port) !== target.endpoint ||
				appConnection.database !== target.app ||
				bootConnection.database !== target.boot ||
				appConnection.username === bootConnection.username
			)
				return yield* invalid();
		}
		return store;
	}).pipe(Effect.mapError(invalid));
