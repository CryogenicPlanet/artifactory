import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { bootstrapConfiguration, bootstrapServices, openBootstrapClient } from "./transfer-bootstrap-config.ts";

Effect.gen(function* () {
	const config = yield* bootstrapConfiguration;
	const app = yield* openBootstrapClient(config.writer),
		boot = yield* openBootstrapClient(config.boot);
	const tables =
		yield* app`SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
	const bootTables =
		yield* boot`SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`;
	const identities = tables.some((row) => row.name === "store_identity")
		? yield* app`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`
		: [];
	const versions = bootTables.some((row) => row.name === "boot_migrations")
		? yield* boot`SELECT MAX(migration_id) AS version FROM boot_migrations`
		: [];
	const generations = bootTables.some((row) => row.name === "generations")
		? yield* boot`SELECT n,status,good,CASE WHEN error LIKE '%app_store_identity_invalid%' THEN 1 ELSE 0 END AS refused FROM generations`
		: [];
	const attempts = bootTables.some((row) => row.name === "child_attempts")
		? yield* boot`SELECT id,opened FROM child_attempts`
		: [];
	yield* Console.log(JSON.stringify({ tables, bootTables, identities, versions, generations, attempts }));
}).pipe(Effect.scoped, Effect.provide(bootstrapServices), BunRuntime.runMain);
