import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect, FileSystem, Result } from "effect";
import { decodeTransferConfiguration } from "../../src/transfer/configuration.ts";
import { runTransfer } from "../../src/transfer/outer.ts";

const main = Effect.scoped(
	Effect.gen(function* () {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(originalPlatform);
		yield* Effect.addFinalizer(() => Effect.sync(() => Object.defineProperty(process, "platform", originalPlatform)));
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const fs = yield* FileSystem.FileSystem;
		const temporary = yield* fs.makeTempDirectoryScoped();
		const root = yield* fs.realPath(temporary);
		const transferId = "22222222-2222-4222-8222-222222222222";
		const directory = `${root}/transfers/${transferId}`;
		yield* fs.makeDirectory(directory, { recursive: true });
		const receipt = JSON.stringify({
			phase: "complete",
			binding: {
				version: 1,
				transfer_id: transferId,
				data_directory: "/data",
				source: { engine: "sqlite", endpoint: null, boot: "/data/boot.db", app: "/data/store/restored.db" },
				target: { engine: "pg", endpoint: "localhost:5432", boot: "target_boot", app: "target_app" },
				store_id: "33333333-3333-4333-8333-333333333333",
				manifest: "a".repeat(64),
			},
		});
		yield* fs.writeFileString(`${directory}/journal.json`, receipt);
		const mapped = (name: string) => {
			assert.ok(name === "/data" || name.startsWith("/data/"));
			return root + name.slice(5);
		};
		let opens = 0;
		const filesystem: FileSystem.FileSystem = {
			...fs,
			readDirectory: (name, options) => fs.readDirectory(mapped(name), options),
			realPath: (name) =>
				fs.realPath(mapped(name)).pipe(Effect.map((resolved) => "/data" + resolved.slice(root.length))),
			stat: (name) => fs.stat(mapped(name)),
			readFileString: (name, encoding) => fs.readFileString(mapped(name), encoding),
			open: (name, options) => {
				opens += 1;
				return fs.open(mapped(name), options);
			},
		};
		for (const mode of ["transfer", "check"] as const) {
			const configuration = yield* decodeTransferConfiguration(
				JSON.stringify({
					version: 1,
					tls: false,
					transfer_id: transferId,
					mode,
					source: { boot: "file:/data/boot.db", app: "file:/data/store/comms.db" },
					target: {
						boot: "postgres://boot:fixture@localhost/target_boot",
						app: "postgres://app:fixture@localhost/target_app",
					},
				}),
			);
			const result = yield* runTransfer(configuration).pipe(
				Effect.provideService(FileSystem.FileSystem, filesystem),
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ DATA_DIR: "/data", COMMS_LOCKED_COMMAND: "store-transfer" }),
				),
				Effect.result,
			);
			if (mode === "transfer") {
				assert.ok(Result.isSuccess(result));
				assert.equal(result.success.status, "complete");
				assert.equal(opens, 2);
			} else {
				assert.ok(Result.isFailure(result));
				assert.equal(result.failure._tag, "TransferRejected");
				assert.equal(opens, 2);
			}
			assert.equal(yield* fs.readFileString(`${directory}/journal.json`), receipt);
			assert.deepEqual(yield* fs.readDirectory(directory), ["journal.json"]);
		}
		return "Completed transfer replay and check refusal verified";
	}),
);
BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer), Effect.flatMap(Console.log)));
