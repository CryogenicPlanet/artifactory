import { Config, Effect, Redacted } from "effect";
import { asBoot, connectionOf, parseDescriptor, StoreError, type FileStore } from "@comms/storage/store";

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
		const appConnection = yield* connectionOf(app, tls);
		const bootConnection = yield* connectionOf(boot, tls);
		if (appConnection.username === bootConnection.username)
			return yield* new StoreError({ code: "store_descriptor_mismatch" });
		return {
			_tag: "remote" as const,
			app,
			boot,
			bootApp,
			appConnection,
			bootConnection,
			bootAppConnection: yield* connectionOf(bootApp, tls),
		};
	});
