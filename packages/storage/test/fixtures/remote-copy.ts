import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Redacted } from "effect";
import { dumpRemote, loadRemote } from "../../src/remote-copy.ts";
import type { RemoteStore } from "../../src/store.ts";
const root = process.argv[2];
const engine = process.argv[3];
const mode = process.argv[4];
if (!root || (engine !== "postgres" && engine !== "mysql")) throw Error("Missing arguments");
const database = process.argv[5] ?? "copy_board";
const store: RemoteStore = {
	_tag: engine,
	url: Redacted.make(`${engine}://copy_user:dummy%22secret%5Cvalue@127.0.0.1:12345/${encodeURIComponent(database)}`),
	database: mode === "invalid" ? "other_board" : database,
};
const artifact = { path: `${root}/artifact`, engine: engine === "postgres" ? "pg" : "mysql" } as const;
const operation =
	mode === "load" || mode === "foreign"
		? loadRemote({
				store,
				artifact: mode === "foreign" ? { ...artifact, engine: engine === "postgres" ? "mysql" : "pg" } : artifact,
				budget: "2 seconds",
			})
		: dumpRemote({ store, path: artifact.path, budget: mode === "hang" ? "1 second" : "2 seconds" });
operation.pipe(
	Effect.result,
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
