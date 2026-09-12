import { on } from "@comms/storage/dialect";
import { asBoot, type Store } from "@comms/storage/store";
import {
	TransferRejected,
	validateTransferSelection,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";
import { Effect, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { decodeRows } from "./decode-rows.ts";
const rejected = () => new TransferRejected({ code: "transfer_journal_conflict" });

/** Bind the real guarded target clients before any preparation or kernel mutation. */
export const bindTransferTarget = (
	stores: { readonly appStore: Store; readonly bootStore: Store },
	boot: SqlClient.SqlClient,
	app: SqlClient.SqlClient,
	selected: TransferSelection,
	seed: { readonly initialized_at: number; readonly epoch: string },
) =>
	Effect.gen(function* () {
		const appStore = stores.appStore;
		const bootStore = stores.bootStore;
		if ((appStore._tag === "file") !== (bootStore._tag === "file")) return yield* rejected();
		const credentials = yield* Effect.try({
			try: () => {
				if (appStore._tag === "file" || bootStore._tag === "file")
					return { principal: "", bootPrincipal: "", endpoint: null };
				const app = new URL(Redacted.value(appStore.url));
				const boot = new URL(Redacted.value(bootStore.url));
				return {
					principal: decodeURIComponent(app.username),
					bootPrincipal: decodeURIComponent(boot.username),
					endpoint: `${app.hostname}:${app.port || (appStore._tag === "postgres" ? "5432" : "3306")}`,
				};
			},
			catch: rejected,
		});
		if (appStore._tag !== "file" && bootStore._tag !== "file") {
			yield* asBoot(appStore, bootStore);
			if (!credentials.principal || !credentials.bootPrincipal || credentials.principal === credentials.bootPrincipal)
				return yield* rejected();
		}
		const selection = yield* validateTransferSelection(selected);
		const engine = on(app, { sqlite: () => "sqlite", pg: () => "pg", mysql: () => "mysql" });
		const databaseName = appStore._tag === "file" ? appStore.filename : appStore.database;
		const bootDatabase = bootStore._tag === "file" ? bootStore.filename : bootStore.database;
		if (
			engine !== selection.target.engine ||
			selection.target.app !== databaseName ||
			selection.target.boot !== bootDatabase ||
			selection.target.endpoint !== credentials.endpoint ||
			!Number.isSafeInteger(seed.initialized_at) ||
			seed.initialized_at < 0 ||
			!/^[a-f0-9]{64}(?![\s\S])/.test(seed.epoch) ||
			Option.isSome(yield* Effect.serviceOption(app.transactionService)) ||
			Option.isSome(yield* Effect.serviceOption(boot.transactionService))
		)
			return yield* rejected();
		if (appStore._tag === "file") {
			const files = yield* app`PRAGMA database_list`.pipe(
				decodeRows(Schema.Struct({ name: Schema.String, file: Schema.String })),
			);
			const bootFiles = yield* boot`PRAGMA database_list`.pipe(
				decodeRows(Schema.Struct({ name: Schema.String, file: Schema.String })),
			);
			if (
				files.find((file) => file.name === "main")?.file !== databaseName ||
				bootFiles.find((file) => file.name === "main")?.file !== bootDatabase
			)
				return yield* rejected();
		} else {
			const actual = yield* on(app, {
				sqlite: () => {
					throw new Error("Expected remote client");
				},
				pg: () => app`SELECT current_database() AS name,session_user AS principal,current_user AS effective`,
				mysql: () =>
					app`SELECT DATABASE() AS name,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS principal,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS effective`,
			}).pipe(decodeRows(Schema.Struct({ name: Schema.String, principal: Schema.String, effective: Schema.String })));
			if (
				actual.length !== 1 ||
				actual[0]?.name !== databaseName ||
				actual[0]?.principal !== credentials.bootPrincipal ||
				actual[0]?.effective !== credentials.bootPrincipal
			)
				return yield* rejected();
			const selectedBoot = yield* on(boot, {
				sqlite: () => {
					throw new Error("Expected remote boot");
				},
				pg: () => boot`SELECT current_database() AS name,session_user AS principal,current_user AS effective`,
				mysql: () =>
					boot`SELECT DATABASE() AS name,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS principal,SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS effective`,
			}).pipe(decodeRows(Schema.Struct({ name: Schema.String, principal: Schema.String, effective: Schema.String })));
			if (
				selectedBoot.length !== 1 ||
				selectedBoot[0]?.name !== bootDatabase ||
				selectedBoot[0]?.principal !== credentials.bootPrincipal ||
				selectedBoot[0]?.effective !== credentials.bootPrincipal
			)
				return yield* rejected();
		}
		return { selection, appStore, bootStore, credentials, engine, databaseName, bootDatabase };
	});
