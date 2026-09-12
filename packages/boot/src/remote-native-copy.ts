import type { TransferDumpReference } from "./transfer-dump-authority.ts";
import { Crypto, Effect } from "effect";
import type { RemoteArtifact } from "@comms/storage/remote-copy";
import { StoreError, type RemoteStore } from "@comms/storage/store";
import { nativeCopyRunner } from "./native-copy-process.ts";
import type { RemoteRuntime } from "./remote-runtime.ts";

export type RemoteNativeCopy = {
	readonly resourceId: string;
	readonly store: RemoteStore;
	readonly budgetMs: number;
} & (
	| { readonly operation: "dump"; readonly path: string; readonly transferDump?: typeof TransferDumpReference.Type }
	| { readonly operation: "load"; readonly artifact: RemoteArtifact; readonly ownership: "preserve" | "current-role" }
);

/** Every native operation gets an independently reserved account owner before its keeper starts. */
export const remoteNativeCopy = (runtime: RemoteRuntime) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const run = yield* nativeCopyRunner;
		return (operation: RemoteNativeCopy) =>
			Effect.gen(function* () {
				if (
					operation.operation === "dump" &&
					operation.transferDump &&
					operation.transferDump.resourceId !== operation.resourceId
				)
					return yield* new StoreError({ code: "store_descriptor_mismatch" });
				const id = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
				const remote = yield* runtime.reserveOwner(
					operation.store,
					id,
					"account",
					operation.operation === "dump" ? operation.transferDump : undefined,
				);
				return yield* run({ ...operation, id, remote });
			});
	});
