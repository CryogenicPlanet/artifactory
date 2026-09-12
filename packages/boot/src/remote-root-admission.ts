import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { RemoteAdmission, type RemoteOwnerIntent, RemoteOwnerRejected } from "./remote-owner.ts";

/** Survives lost acknowledgements. Only this guardian may advance this ledger. */
export const remoteRootAdmission = (dataDirectory: string, root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const filename = path.join(dataDirectory, `remote-admission-${root}.json`);
		const syncDirectory = Effect.scoped(fs.open(dataDirectory).pipe(Effect.flatMap((file) => file.sync)));
		const encode = Schema.encodeSync(Schema.fromJsonString(RemoteAdmission));
		let current: typeof RemoteAdmission.Type = { root, state: "open", owners: [] };
		const gate = yield* Semaphore.make(1);
		const write = (value: typeof RemoteAdmission.Type, initial = false) =>
			Effect.gen(function* () {
				const target = initial ? filename : `${filename}.tmp`;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const file = yield* fs.open(target, { flag: "wx", mode: 0o600 });
						yield* file.writeAll(new TextEncoder().encode(encode(value)));
						yield* file.sync;
					}),
				);
				if (!initial) yield* fs.rename(target, filename);
				yield* syncDirectory;
				current = value;
			});
		yield* write(current, true);
		return {
			reserve: (intent: RemoteOwnerIntent) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (
							current.state !== "open" ||
							intent.root !== root ||
							current.owners.some((item) => item.intent.attempt === intent.attempt)
						)
							return yield* new RemoteOwnerRejected({ code: "remote_owner_invalid" });
						yield* write({ ...current, owners: [...current.owners, { intent, admitted: false }] });
					}),
				),
			admit: (attempt: string) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (
							current.state !== "open" ||
							!current.owners.some((item) => item.intent.attempt === attempt && !item.admitted)
						)
							return yield* new RemoteOwnerRejected({ code: "remote_owner_closed" });
						yield* write({
							...current,
							owners: current.owners.map((item) =>
								item.intent.attempt === attempt ? { ...item, admitted: true } : item,
							),
						});
					}),
				),
			close: gate.withPermit(
				Effect.gen(function* () {
					if (current.state === "open") yield* write({ ...current, state: "closed" });
				}),
			),
			workerClosed: <E, R>(proof: Effect.Effect<void, E, R>) =>
				gate.withPermit(
					Effect.gen(function* () {
						if (current.state !== "closed") return yield* new RemoteOwnerRejected({ code: "remote_owner_invalid" });
						yield* proof;
						yield* write({ ...current, state: "worker-closed" });
						return current.owners;
					}),
				),
		};
	});
