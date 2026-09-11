import type { Cause, Effect, PlatformError, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Message, MessageInput, Envelope } from "@comms/protocol/messages";
import type { TopicResult } from "@comms/protocol/topics";
import type { TopicMutation } from "@comms/protocol/topic-operations";
import type { EventRecord } from "@comms/protocol/events";
import type { BootChannel, KernelError } from "./boot-channel.ts";
import type { Mutation } from "./mutate.ts";
import type { Identity } from "./identity.ts";

export interface MessageQuery {
	readonly since?: number;
	readonly topic?: string;
	readonly recursive?: boolean;
	readonly limit: number;
	readonly exclude?: string;
	readonly newest?: boolean;
	readonly tag?: string;
	readonly agent?: string;
	readonly q?: string;
	readonly mentions?: ReadonlyArray<string>;
}
type StorageError = KernelError | SqlError | Schema.SchemaError | PlatformError.PlatformError;
interface PageError extends Cause.YieldableError {
	readonly _tag: "PageRejected";
	readonly code: "page_not_found" | "page_path_invalid" | "pages_unavailable" | "pages_move_pending";
}
/** Public extension verbs; core implements this contract without defining the loader's types. */
export interface ExtensionCapabilities {
	readonly generation: number;
	readonly events: Pick<BootChannel["Service"], "changed"> & { readonly query: BootChannel["Service"]["events"] };
	readonly drained: Effect.Effect<void>;
	readonly read: <A, E, R>(read: (fence: number) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | StorageError, R>;
	readonly mutate: <A, E, R>(
		input: Effect.Effect<A, E, R> | Omit<Mutation<A, E, R>, "guard">,
	) => Effect.Effect<A, E | StorageError, R>;
	readonly messages: {
		readonly query: (input: MessageQuery) => Effect.Effect<typeof Envelope.Type, StorageError>;
		readonly create: (
			input: typeof MessageInput.Type,
			key?: string,
		) => Effect.Effect<typeof Message.Type, StorageError>;
	};
	readonly topics: {
		readonly read: (
			path: string,
			options?: { readonly depth?: number; readonly archived?: boolean },
		) => Effect.Effect<typeof TopicResult.Type, StorageError | PageError | PlatformError.PlatformError>;
		readonly meta: (
			path: string,
			meta: Schema.JsonObject,
			key?: string,
		) => Effect.Effect<typeof TopicMutation.Type, StorageError>;
		readonly markRead: (path: string, seq: number) => Effect.Effect<void, StorageError>;
	};
	readonly emit: <E = never>(
		type: string,
		payload: Schema.JsonObject,
		change?: (seq: number) => Effect.Effect<void, E>,
	) => Effect.Effect<typeof EventRecord.Type, E | StorageError>;
}
export type CapabilityFactory = (extension: string, who?: Identity, writable?: boolean) => ExtensionCapabilities;
