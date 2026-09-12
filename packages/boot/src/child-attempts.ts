import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelBoot, validateKernelBootId } from "./kernel-boot.ts";
import { ChildError } from "./child-process.ts";

/** A keeper publishes this file only after local and, when applicable, remote account closure.
 * Remote callers must also retain the independent root inventory/guardian proof. */
export const childReceiptClosed = (directory: string, id: string, receipt: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const receipts = path.join(directory, "attempts");
		if (!id || path.basename(id) !== id || id === "." || id === ".." || receipt !== path.join(receipts, `${id}.closed`))
			return yield* new ChildError({ code: "child_receipt_invalid" });
		return yield* Effect.gen(function* () {
			const root = yield* fs.realPath(directory);
			if ((yield* fs.realPath(receipts)) !== path.join(root, "attempts")) return false;
			if ((yield* fs.realPath(receipt)) !== path.join(root, "attempts", `${id}.closed`)) return false;
			const info = yield* fs.stat(receipt);
			if (info.type !== "File" || info.size !== BigInt(new TextEncoder().encode(id).length)) return false;
			return (yield* fs.readFileString(receipt)) === id;
		}).pipe(Effect.orElseSucceed(() => false));
	});

/** Read-only transfer admission. Unlike local startup, kernel rollover alone is not a
 * transferable receipt: the destination may use a remote store on the same volume. */
export const assertChildAttemptsClosed = (sql: SqlClient.SqlClient, directory: string) =>
	Effect.gen(function* () {
		const owners = yield* sql`SELECT id,receipt,closed FROM child_attempts WHERE closed<>1 OR closed IS NULL`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ id: Schema.String, receipt: Schema.String, closed: Schema.Literal(0) })),
				),
			),
			Effect.mapError(() => new ChildError({ code: "child_receipt_invalid" })),
		);
		for (const owner of owners)
			if (!(yield* childReceiptClosed(directory, owner.id, owner.receipt)))
				return yield* new ChildError({ code: "child_closure_unproven" });
	});

/** Durable process ownership evidence. A missing receipt is never interpreted as a dead process. */
const make = (directory: string, remote = false) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const bootId = validateKernelBootId((yield* KernelBoot).id);
		const receipts = path.join(directory, "attempts");
		const closed = (id: string, receipt: string) =>
			Effect.gen(function* () {
				if (
					!(yield* childReceiptClosed(directory, id, receipt).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path),
					))
				)
					return false;
				yield* sql`UPDATE child_attempts SET closed=1 WHERE id=${id}`;
				return true;
			});
		return {
			reserve: (generation: number) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(receipts, { recursive: true, mode: 0o700 });
					const id = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
					const receipt = path.join(receipts, `${id}.closed`);
					// Editable imports can open the store before the go handshake. Reservation is the durable spawn intent.
					yield* sql`INSERT INTO child_attempts(id,generation,receipt,boot_id,opened) VALUES(${id},${generation},${receipt},${bootId},1)`;
					return { id, receipt };
				}),
			opened: (id: string) => sql`UPDATE child_attempts SET opened=1 WHERE id=${id}`.pipe(Effect.asVoid),
			closed,
			recover: Effect.gen(function* () {
				// Older versions marked opened only after imports; their unopened rows also need closure proof.
				const owners = yield* sql`SELECT id,receipt,boot_id FROM child_attempts WHERE closed=0`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({ id: Schema.String, receipt: Schema.String, boot_id: Schema.NullOr(Schema.String) }),
							),
						),
					),
				);
				for (const owner of owners) {
					const priorBootId = validateKernelBootId(owner.boot_id);
					// A changed kernel lifetime closes every previous process, even when power loss prevented receipts.
					// Same-kernel container or keeper restarts still require positive keeper evidence.
					if (!remote && bootId !== null && priorBootId !== null && bootId !== priorBootId) {
						yield* sql`UPDATE child_attempts SET closed=1 WHERE id=${owner.id}`;
						continue;
					}
					let verified = false;
					for (let attempt = 0; attempt < 60 && !verified; attempt++) {
						verified = yield* closed(owner.id, owner.receipt);
						if (!verified) yield* Effect.sleep("100 millis");
					}
					if (!verified) return yield* new ChildError({ code: "child_closure_unproven" });
				}
			}),
		};
	});
export class ChildAttempts extends Context.Service<ChildAttempts, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/ChildAttempts",
) {}
export const layer = (directory: string, remote = false) => Layer.effect(ChildAttempts, make(directory, remote));
