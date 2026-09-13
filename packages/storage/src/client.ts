import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import type { Duration } from "effect";
import type { FileStore } from "./store.ts";

/** Opening the client never changes journal mode; the owning schema does that after version checks. */
export const clientLayer = (
	store: FileStore,
	options: {
		readonly readonly?: boolean;
		readonly busyTimeout?: Duration.Input;
	} = {},
) => SqliteClient.layer({ filename: store.filename, ...options, disableWAL: true });
