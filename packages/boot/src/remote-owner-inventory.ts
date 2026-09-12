import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { RemoteOwnerIntent, RemoteOwnerRejected, recoverRemoteOwners } from "./remote-owner.ts";

const Inventory = Schema.Struct({ version: Schema.Literal(1), owners: Schema.Array(RemoteOwnerIntent) });
const invalid = () => new RemoteOwnerRejected({ code: "remote_owner_invalid" });

/** One boot-owned inventory, recovered before any remote connection opens.
 * Keepers may update their own receipts, but never this independent expected-owner list. */
export const remoteOwnerInventory = (dataDirectory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const filename = path.join(dataDirectory, "remote-owner-inventory.json");
		const temporary = `${filename}.tmp`;
		const encode = Schema.encodeSync(Schema.fromJsonString(Inventory));
		const syncDirectory = Effect.scoped(fs.open(dataDirectory).pipe(Effect.flatMap((file) => file.sync)));
		const claim = path.join(dataDirectory, ".remote-owner-inventory.lock");
		let recovered = false;
		if ((yield* fs.realPath(dataDirectory)) !== dataDirectory) return yield* invalid();
		// Serialize entire root lifetimes, not just writes inside one instance. An
		// orphan claim fails closed; a PID or changed kernel ID is not remote proof.
		yield* Effect.acquireRelease(
			Effect.scoped(fs.open(claim, { flag: "wx", mode: 0o600 }).pipe(Effect.flatMap((file) => file.sync))).pipe(
				Effect.andThen(syncDirectory),
				Effect.mapError(invalid),
			),
			() =>
				Effect.suspend(() =>
					recovered
						? recoverRemoteOwners(dataDirectory, current.owners).pipe(
								Effect.matchEffect({
									onFailure: () => Effect.void,
									onSuccess: () => fs.remove(claim).pipe(Effect.andThen(syncDirectory), Effect.orDie),
								}),
							)
						: Effect.void,
				),
		);
		const write = (value: typeof Inventory.Type) =>
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
						yield* file.writeAll(new TextEncoder().encode(encode(value)));
						yield* file.sync;
					}),
				);
				yield* fs.rename(temporary, filename);
				yield* syncDirectory;
			});
		const exists = yield* fs.exists(filename);
		if (exists && ((yield* fs.realPath(filename)) !== filename || (yield* fs.stat(filename)).type !== "File"))
			return yield* invalid();
		let current: typeof Inventory.Type = exists
			? yield* fs
					.readFileString(filename)
					.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Inventory))), Effect.mapError(invalid))
			: { version: 1, owners: [] };
		if (new Set(current.owners.map((owner) => owner.attempt)).size !== current.owners.length) return yield* invalid();
		// Missing inventory cannot turn existing owner files into a fresh deployment.
		yield* recoverRemoteOwners(dataDirectory, current.owners);
		recovered = true;
		if (yield* fs.exists(temporary)) {
			if (!exists || (yield* fs.realPath(temporary)) !== temporary || (yield* fs.stat(temporary)).type !== "File")
				return yield* invalid();
			// No owner may open until its inventory rename + directory sync completes.
			// An unpublished replacement is disposable only after all published owners close.
			yield* fs.remove(temporary);
			yield* syncDirectory;
		}
		if (!exists) yield* write(current);
		const gate = yield* Semaphore.make(1);
		return {
			snapshot: Effect.sync(() => current.owners),
			/** Must finish before creating the per-owner journal or spawning its keeper. */
			reserve: (owner: RemoteOwnerIntent) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (
							!/^[a-f0-9]{64}$/.test(owner.attempt) ||
							!/^[a-f0-9]{64}$/.test(owner.root) ||
							!owner.database ||
							!owner.host ||
							!owner.username ||
							!Number.isSafeInteger(owner.port) ||
							owner.port < 1 ||
							owner.port > 65535 ||
							current.owners.some((item) => item.attempt === owner.attempt)
						)
							return yield* invalid();
						const next = { version: 1 as const, owners: [...current.owners, owner] };
						yield* write(next);
						current = next;
					}),
				),
		};
	});
