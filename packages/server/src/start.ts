import { boot } from "@comms/boot";
import { Effect, Path } from "effect";

/** Launches the headless stack through boot.
 * The child uses a separate entry to avoid recursively launching boot. */
export const startServer = Effect.gen(function* () {
	const path = yield* Path.Path;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = yield* path.fromFileUrl(new URL(`./server.${extension}`, import.meta.url));
	yield* boot(entry);
}).pipe(Effect.scoped);
