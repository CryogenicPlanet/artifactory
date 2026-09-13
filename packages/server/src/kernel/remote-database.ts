import { clientLayer } from "@comms/storage/client";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import { connectionOf, type Store } from "@comms/storage/store";
import { Config, Effect, Layer } from "effect";

export const databaseLayer = (store: Store) =>
	Layer.unwrap(
		Effect.gen(function* () {
			if (store._tag === "file") return clientLayer(store);
			const tls = yield* Config.Boolean("DATABASE_TLS").pipe(Config.withDefault(false));
			return advisoryClientLayer({ connection: yield* connectionOf(store, tls) });
		}),
	);
