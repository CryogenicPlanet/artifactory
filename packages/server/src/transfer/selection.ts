import { TransferRejected, validateTransferSelection } from "@comms/storage/store-transfer-schema";
import type { Store } from "@comms/storage/store";
import { Effect, FileSystem, Option, Path, Redacted } from "effect";

const invalid = () => new TransferRejected({ code: "transfer_binding_invalid" });

/** Public binding derives from the actual selected stores, never transport-host spelling
 * or configured app defaults that may have been superseded by a verified restore. */
export const transferSelection = (options: {
	readonly transferId: string;
	readonly storeId: string;
	readonly dataDirectory: string;
	readonly mode: "check" | "transfer";
	readonly source: { readonly boot: Store; readonly app: Store };
	readonly target: { readonly boot: Store; readonly app: Store };
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.realPath(options.dataDirectory);
		if (root !== options.dataDirectory) return yield* invalid();
		const pair = (stores: typeof options.source) =>
			Effect.gen(function* () {
				if (stores.boot._tag === "file" || stores.app._tag === "file") {
					if (stores.boot._tag !== "file" || stores.app._tag !== "file") return yield* invalid();
					for (const store of [stores.boot, stores.app]) {
						if (!path.isAbsolute(store.filename) || path.normalize(store.filename) !== store.filename)
							return yield* invalid();
					}
					return { engine: "sqlite" as const, endpoint: null, boot: stores.boot.filename, app: stores.app.filename };
				}
				const endpoint = (store: typeof stores.boot) =>
					Effect.try({
						try: () => {
							const url = new URL(Redacted.value(store.url));
							return `${url.hostname.toLowerCase()}:${url.port || (store._tag === "postgres" ? "5432" : "3306")}`;
						},
						catch: invalid,
					});
				const boot = yield* endpoint(stores.boot);
				const app = yield* endpoint(stores.app);
				if (stores.boot._tag !== stores.app._tag || boot !== app) return yield* invalid();
				return {
					engine: stores.boot._tag === "postgres" ? ("pg" as const) : ("mysql" as const),
					endpoint: boot,
					boot: stores.boot.database,
					app: stores.app.database,
				};
			});
		const source = yield* pair(options.source);
		const target = yield* pair(options.target);
		if (source.engine === target.engine) return yield* invalid();
		if (target.engine === "sqlite") {
			const expectedBoot =
				options.mode === "check"
					? path.join(root, "transfers", options.transferId, "scratch", "boot.db")
					: path.join(root, "boot.db");
			const expectedApp =
				options.mode === "check"
					? path.join(root, "rehearsals", `transfer-check-${options.transferId}`, "comms.db")
					: path.join(root, "store", "comms.db");
			if (target.boot !== expectedBoot || target.app !== expectedApp) return yield* invalid();
		}
		// Existing source files must be canonical regular files and distinct physical objects.
		if (source.engine === "sqlite") {
			const boot = yield* fs.stat(source.boot);
			const app = yield* fs.stat(source.app);
			if (
				boot.type !== "File" ||
				app.type !== "File" ||
				(yield* fs.realPath(source.boot)) !== source.boot ||
				(yield* fs.realPath(source.app)) !== source.app ||
				Option.isNone(boot.ino) ||
				Option.isNone(app.ino) ||
				(boot.dev === app.dev && boot.ino.value === app.ino.value)
			)
				return yield* invalid();
		}
		return yield* validateTransferSelection({
			version: 1,
			transfer_id: options.transferId,
			data_directory: root,
			source,
			target,
			store_id: options.storeId,
		});
	});
