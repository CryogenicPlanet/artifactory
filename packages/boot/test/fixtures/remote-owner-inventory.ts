import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path } from "effect";
import { remoteOwner } from "../../src/remote-owner.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(process.argv[2] ?? "");
	const mode = process.argv[3];
	if (mode === "recover") return yield* remoteOwnerInventory(root);
	const inventory = yield* remoteOwnerInventory(root);
	if (mode === "claim") {
		yield* Console.log("INVENTORY_CLAIMED");
		return yield* Effect.never;
	}
	const intent = (index: number) => ({
		attempt: String(index).padStart(64, "a"),
		root: "b".repeat(64),
		engine: "pg" as const,
		scope: "database" as const,
		database: "app",
		host: "localhost",
		port: 5432,
		tls: false,
		username: "app",
	});
	const selected = intent(1);
	if (mode !== "extra") yield* inventory.reserve(selected);
	if (mode === "crash-reserved") {
		yield* Console.log("INVENTORY_DURABLE");
		return yield* Effect.never;
	}
	const owner = yield* remoteOwner(root, selected);
	const tag = Buffer.from(selected.attempt, "hex").toString("base64url");
	yield* owner.bindInspector({
		engine: "pg",
		server: "observed",
		database: "app",
		username: "app",
		connectionId: "10",
		tag: `inspect:${tag}`,
	});
	if (mode === "pending") return;
	yield* owner.close(Effect.void);
	const filename = path.join(root, "remote-owner-inventory.json");
	assert.equal((yield* fs.stat(filename)).mode & 0o777, 0o600);
	if (mode !== "extra") assert.equal((yield* inventory.reserve(selected).pipe(Effect.result))._tag, "Failure");
	if (mode === "missing") yield* fs.remove(path.join(root, "remote-owners", `${selected.attempt}.json`));
	if (mode === "missing-inventory") yield* fs.remove(filename);
	if (mode === "malformed") yield* fs.writeFileString(filename, "{");
	if (mode === "temporary") yield* fs.writeFileString(`${filename}.tmp`, "partial uncommitted replacement");
	if (mode === "parallel") {
		yield* Effect.all(
			Array.from({ length: 8 }, (_, n) => inventory.reserve(intent(n + 2))),
			{ concurrency: 8 },
		);
		// All acknowledged reservations remain expected, although none has a closure journal yet.
		const content = yield* fs.readFileString(filename);
		for (let n = 2; n < 10; n++) assert.ok(content.includes(intent(n).attempt));
	}
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
