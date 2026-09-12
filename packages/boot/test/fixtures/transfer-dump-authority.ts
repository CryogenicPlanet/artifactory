import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";
import { transferDumpJournal } from "../../src/transfer-dump-journal.ts";
import { authorizeTransferDump, TransferDumpReference } from "../../src/transfer-dump-authority.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing isolated root");
await Effect.runPromise(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const selection: TransferSelection = {
			version: 1,
			transfer_id: "11111111-1111-4111-8111-111111111111",
			data_directory: root,
			store_id: "22222222-2222-4222-8222-222222222222",
			source: { engine: "pg", endpoint: "localhost:5432", boot: "boot", app: "app" },
			target: { engine: "sqlite", endpoint: null, boot: `${root}/target-boot`, app: `${root}/target-app` },
		};
		const source = {
			boot: {
				_tag: "postgres" as const,
				database: "boot",
				url: Redacted.make("postgres://owner:secret@localhost/boot"),
			},
			app: { _tag: "postgres" as const, database: "app", url: Redacted.make("postgres://app:secret@localhost/app") },
		};
		const journal = yield* transferDumpJournal(selection, source);
		const record = yield* journal.allocate("boot");
		const credential = yield* journal.credential(record.id);
		const reference = { transferId: selection.transfer_id, resourceId: record.id };
		for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
			assert.equal(
				(yield* Schema.decodeUnknownEffect(TransferDumpReference)({
					...reference,
					resourceId: record.id + suffix,
				}).pipe(Effect.result))._tag,
				"Failure",
			);
			assert.equal(
				(yield* Schema.decodeUnknownEffect(TransferDumpReference)({
					...reference,
					transferId: selection.transfer_id + suffix,
				}).pipe(Effect.result))._tag,
				"Failure",
			);
		}
		const authorize = (store = credential, ref = reference) =>
			authorizeTransferDump(root, source.boot, store, ref, "ready");
		const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.result,
				Effect.map((result) => assert.equal(result._tag, "Failure")),
			);
		yield* refused(authorize()); // Allocation alone never admits native execution.
		yield* authorizeTransferDump(root, source.boot, credential, reference, "cleanup");
		yield* journal.ready(record.id);
		yield* authorize();
		yield* refused(authorize(source.boot));
		yield* refused(authorize(source.app));
		yield* refused(authorize({ ...credential, database: "app" }));
		yield* refused(
			authorize({ ...credential, url: Redacted.make(Redacted.value(credential.url).replace("localhost", "foreign")) }),
		);
		yield* refused(authorize(credential, { ...reference, resourceId: "33333333-3333-4333-8333-333333333333" }));
		yield* refused(authorize(credential, { ...reference, transferId: "44444444-4444-4444-8444-444444444444" }));
		const filename = `${root}/transfers/${selection.transfer_id}/backup-resources/${record.id}.json`;
		const bytes = yield* fs.readFileString(filename);
		const url = new URL(Redacted.value(credential.url));
		const password = decodeURIComponent(url.password);
		url.password = encodeURIComponent(password + "\n");
		yield* fs.writeFileString(filename, bytes.replace(JSON.stringify(password), JSON.stringify(password + "\n")));
		yield* refused(authorize({ ...credential, url: Redacted.make(url.href) }));
		yield* refused(journal.credential(record.id));
		yield* fs.writeFileString(filename, bytes);
		yield* fs.chmod(filename, 0o644);
		yield* refused(authorize());
		yield* fs.chmod(filename, 0o600);
		yield* fs.rename(filename, `${filename}.retained`);
		yield* fs.symlink(`${filename}.retained`, filename);
		yield* refused(authorize());
		yield* fs.remove(filename);
		yield* fs.rename(`${filename}.retained`, filename);
		yield* fs.writeFileString(filename, bytes.replace('"store":"boot"', '"store":"app"'));
		yield* refused(authorize());
		yield* fs.writeFileString(filename, bytes);
		yield* journal.close(record.id);
		yield* refused(authorize());
		yield* authorizeTransferDump(root, source.boot, credential, reference, "cleanup");
		yield* journal.finish(record.id);
		yield* refused(authorizeTransferDump(root, source.boot, credential, reference, "cleanup"));
		process.stdout.write("verified exact offline dump authority\n");
	}).pipe(Effect.provide(BunServices.layer)),
);
