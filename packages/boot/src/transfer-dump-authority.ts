import { connectionOf, StoreError, type RemoteStore } from "@comms/storage/store";
import { validateTransferSelection } from "@comms/storage/store-transfer-schema";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { TransferDumpRecord } from "./transfer-dump-journal.ts";

const uuid = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/),
);
/** Locates existing offline dump authority; never authorizes an ordinary app owner. */
export const TransferDumpReference = Schema.Struct({ transferId: uuid, resourceId: uuid });
const invalid = () => new StoreError({ code: "store_descriptor_mismatch" });

export const authorizeTransferDump = (
	root: string,
	boot: RemoteStore,
	store: RemoteStore,
	reference: typeof TransferDumpReference.Type,
	phase: "ready" | "cleanup",
) =>
	Effect.gen(function* () {
		yield* Schema.decodeUnknownEffect(TransferDumpReference)(reference);
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = path.join(root, "transfers", reference.transferId, "backup-resources");
		for (const name of [root, path.join(root, "transfers"), path.dirname(directory), directory]) {
			const stat = yield* fs.stat(name);
			if (
				(yield* fs.realPath(name)) !== name ||
				stat.type !== "Directory" ||
				(name !== root && (stat.mode & 0o077) !== 0)
			)
				return yield* invalid();
		}
		const filename = path.join(directory, `${reference.resourceId}.json`);
		const stat = yield* fs.stat(filename);
		if (
			(yield* fs.realPath(filename)) !== filename ||
			stat.type !== "File" ||
			stat.size > 32768n ||
			(stat.mode & 0o077) !== 0
		)
			return yield* invalid();
		const saved = yield* fs
			.readFileString(filename)
			.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TransferDumpRecord))));
		yield* validateTransferSelection(saved.selection);
		const selected = yield* connectionOf(store, true);
		const owner = yield* connectionOf(boot, true);
		if (
			saved.id !== reference.resourceId ||
			saved.selection.transfer_id !== reference.transferId ||
			saved.selection.data_directory !== root ||
			saved.store !== "boot" ||
			saved.finished ||
			(phase === "ready" && saved.phase !== "ready") ||
			saved.password === null ||
			!/^[a-f0-9]{64}(?![\s\S])/.test(saved.password) ||
			selected.engine !== owner.engine ||
			selected.host !== owner.host ||
			selected.port !== owner.port ||
			selected.database !== owner.database ||
			saved.selection.source.boot !== owner.database ||
			saved.selection.source.engine !== owner.engine ||
			saved.selection.source.endpoint !==
				`${owner.host.includes(":") ? `[${owner.host}]` : owner.host}:${owner.port}` ||
			selected.username === owner.username ||
			selected.username !== `comms_t_${saved.id.replaceAll("-", "").slice(0, 24)}` ||
			Redacted.value(selected.password) !== saved.password
		)
			return yield* invalid();
	}).pipe(Effect.mapError(invalid));
