import { Cause, Crypto, Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import type { Api } from "./extension-api.ts";
import { discoverExtensions } from "./extension-discovery.ts";
import { makeExtensionMigrate, migrationEngine, migrationSql, type MigrationEngine } from "./extension-migrations.ts";
import { assertNoPendingMigration } from "./migration-intent.ts";
import { work, type Work } from "./extension-work.ts";

export class TransferExtensionError extends Schema.TaggedError<TransferExtensionError>()("TransferExtensionError", {
	code: Schema.Literals(["transfer_extension_failed", "transfer_extension_context_forbidden"]),
}) {
	get message() {
		return this.code;
	}
}
const factory = Schema.Struct({
	default: Schema.declare<(api: Api) => Work<void> | void>(
		(value): value is (api: Api) => Work<void> | void => typeof value === "function",
	),
});

export interface ExtensionMigrationProof {
	readonly extension: string;
	readonly name: string;
	readonly sourceChecksum: string;
	readonly targetChecksum: string;
}

/** Replay trusted frozen factories for migrations only. Imports and arbitrary JS are not sandboxed.
 * The caller prepares kernel/core schemas and owns the guarded pool and offline writer epoch. */
export const transferExtensionMigrations = (
	sql: SqlClient.SqlClient,
	epoch: string,
	directory: string,
	sourceEngine: MigrationEngine = migrationEngine(sql),
) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const proofs: ExtensionMigrationProof[] = [];
		const hash = (statement: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(statement))
				.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if ((yield* fs.realPath(directory)) !== directory)
			return yield* new TransferExtensionError({ code: "transfer_extension_failed" });
		yield* assertNoPendingMigration(sql);
		for (const entry of yield* discoverExtensions(directory)) {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const migrate = yield* makeExtensionMigrate(sql, epoch, entry.name);
					const gate = yield* Semaphore.make(1);
					let open = true;
					let failed = false;
					const refuse = (): never => {
						failed = true;
						throw new TransferExtensionError({ code: "transfer_extension_context_forbidden" });
					};
					const api: Api = {
						get effects() {
							return refuse();
						},
						context: refuse,
						mount: () => {},
						page: () => {},
						cron: () => {},
						route: () => {},
						on: () => {},
						migrate: (...args) =>
							gate.withPermit(
								Effect.suspend(() => {
									if (!open) return Effect.fail(new KernelError({ code: "extension_migration_invalid" }));
									return Effect.gen(function* () {
										const [name, declaration, options] = args;
										const sourceStatement = migrationSql(declaration, sourceEngine);
										const targetStatement = migrationSql(declaration, migrationEngine(sql));
										const proof = {
											extension: entry.name,
											name,
											sourceChecksum: yield* hash(sourceStatement),
											targetChecksum: yield* hash(targetStatement),
										};
										const prior = proofs.find((row) => row.extension === entry.name && row.name === name);
										if (
											prior &&
											(prior.sourceChecksum !== proof.sourceChecksum || prior.targetChecksum !== proof.targetChecksum)
										)
											return yield* new KernelError({ code: "extension_migration_conflict" });
										yield* migrate(name, targetStatement, options);
										if (!prior) proofs.push(proof);
									}).pipe(
										Effect.onError(() =>
											Effect.sync(() => {
												failed = true;
											}),
										),
									);
								}),
							),
					};
					const url = (yield* path.toFileUrl(yield* entry.path)).href;
					yield* Effect.gen(function* () {
						const imported: unknown = yield* Effect.tryPromise(() => import(url));
						const loaded = yield* Schema.decodeUnknownEffect(factory)(imported);
						yield* work(() => loaded.default(api), true);
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								open = false;
							}).pipe(Effect.andThen(gate.withPermit(Effect.void))),
						),
					);
					yield* assertNoPendingMigration(sql);
					if (failed) return yield* new TransferExtensionError({ code: "transfer_extension_failed" });
				}),
			);
		}
		return proofs.toSorted((a, b) => {
			const left = `${a.extension}\0${a.name}`;
			const right = `${b.extension}\0${b.name}`;
			return left < right ? -1 : left > right ? 1 : 0;
		});
	}).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.fail(new TransferExtensionError({ code: "transfer_extension_failed" })),
		),
	);
