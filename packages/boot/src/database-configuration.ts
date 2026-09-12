import { Config, Effect, Redacted } from "effect";
import { asBoot, parseDescriptor, StoreError, type FileStore, type RemoteStore } from "@comms/storage/store";
import type { RemoteConnection } from "@comms/storage/remote-session";

const connection = (store: RemoteStore, tls: boolean) =>
	Effect.try({
		try: (): RemoteConnection => {
			const url = new URL(Redacted.value(store.url));
			const username = decodeURIComponent(url.username);
			const password = decodeURIComponent(url.password);
			if (!username || !password) throw new Error();
			return {
				engine: store._tag === "postgres" ? "pg" : "mysql",
				host: url.hostname.replace(/^\[|\]$/g, ""),
				port: Number(url.port || (store._tag === "postgres" ? 5432 : 3306)),
				database: store.database,
				username,
				password: Redacted.make(password),
				tls,
			};
		},
		catch: () => new StoreError({ code: "store_descriptor_invalid" }),
	});

/** Pair selection happens before any client opens. Remote authority is established separately. */
export const databaseConfiguration = (bootFile: string, appFile: string) =>
	Effect.gen(function* () {
		const appUrl = yield* Config.Redacted("DATABASE_URL").pipe(Config.withDefault(undefined));
		const bootUrl = yield* Config.Redacted("BOOT_DATABASE_URL").pipe(Config.withDefault(undefined));
		if (appUrl === undefined && bootUrl === undefined)
			return {
				_tag: "file" as const,
				boot: { _tag: "file", filename: bootFile } satisfies FileStore,
				app: { _tag: "file", filename: appFile } satisfies FileStore,
			};
		if (appUrl === undefined || bootUrl === undefined)
			return yield* new StoreError({ code: "store_descriptor_mismatch" });
		const app = yield* parseDescriptor(Redacted.value(appUrl));
		const boot = yield* parseDescriptor(Redacted.value(bootUrl));
		if (app._tag === "file" || boot._tag === "file") {
			if (app._tag !== "file" || boot._tag !== "file") return yield* new StoreError({ code: "store_engine_mismatch" });
			if (app.filename === boot.filename) return yield* new StoreError({ code: "store_descriptor_mismatch" });
			return { _tag: "file" as const, boot, app };
		}
		const bootApp = yield* asBoot(app, boot);
		const tls = yield* Config.Boolean("DATABASE_TLS").pipe(Config.withDefault(true));
		const appConnection = yield* connection(app, tls);
		const bootConnection = yield* connection(boot, tls);
		if (appConnection.username === bootConnection.username)
			return yield* new StoreError({ code: "store_descriptor_mismatch" });
		return {
			_tag: "remote" as const,
			app,
			boot,
			bootApp,
			appConnection,
			bootConnection,
			bootAppConnection: yield* connection(bootApp, tls),
		};
	});
