import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelBoot, validateKernelBootId } from "./kernel-boot.ts";
import { ChildError } from "./child-process.ts";

/** SQLite replacement needs process receipts. Remote SQL admission belongs to the writing session lock. */
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
				const expected = path.join(receipts, `${id}.closed`);
				if (receipt !== expected) return yield* new ChildError({ code: "child_receipt_invalid" });
				if (remote) return true;
				const content = yield* fs.readFileString(receipt).pipe(Effect.orElseSucceed(() => ""));
				if (content !== id) return false;
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
					if (!remote)
						yield* sql`INSERT INTO child_attempts(id,generation,receipt,boot_id,opened) VALUES(${id},${generation},${receipt},${bootId},1)`;
					return { id, receipt };
				}),
			opened: (id: string) =>
				remote ? Effect.void : sql`UPDATE child_attempts SET opened=1 WHERE id=${id}`.pipe(Effect.asVoid),
			closed,
			recover: Effect.gen(function* () {
				// Do not label old remote processes closed: no local receipt proves remote session ownership.
				if (remote) return;
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
					if (bootId !== null && priorBootId !== null && bootId !== priorBootId) {
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
