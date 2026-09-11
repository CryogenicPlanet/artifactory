import { Crypto, Effect, Option, Ref, type Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { Messages, type Identity, type MessageInput } from "./messages.ts";
import { HealthProbe } from "./health-probe.ts";
import { Lifecycle } from "./lifecycle.ts";
import { Topics } from "./topics.ts";

/** Bind product operations to the caller; persistence stays in the shared mutation service. */
export const extensionCapabilities = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const messages = yield* Messages;
	const topics = yield* Topics;
	const crypto = yield* Crypto.Crypto;
	const lifecycle = yield* Lifecycle;
	return (extension: string, who?: Identity, writable = true) => {
		const caller = who ?? { agent: "system", instance: `extension:${extension}`, request: "", kind: "agent" };
		const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				if (!writable) return yield* new KernelError({ code: "scope_required" });
				// Guarded readiness owns the rollback-only transaction; the shared mutation protocol recognizes this probe.
				if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return yield* effect;
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
					return yield* new KernelError({ code: "input_invalid" });
				yield* Effect.acquireRelease(
					lifecycle.gate.withPermit(
						Effect.gen(function* () {
							if ((yield* Ref.get(lifecycle.state)) !== "live")
								return yield* new KernelError({ code: "generation_not_live" });
							yield* Ref.update(lifecycle.mutations, (count) => count + 1);
						}),
					),
					() => Ref.update(lifecycle.mutations, (count) => count - 1),
				);
				return yield* effect;
			}).pipe(Effect.scoped);
		return {
			events: { query: boot.events, changed: boot.changed },
			mutate: <A, E, R>(change: Effect.Effect<A, E, R>) => write(messages.change(change)),
			messages: {
				query: messages.list,
				create: (input: typeof MessageInput.Type, key?: string) => write(messages.create(caller, input, key)),
			},
			topics: {
				read: (path: string, options: { readonly depth?: number; readonly archived?: boolean } = {}) =>
					topics.detail(caller, path, options.depth, options.archived),
				meta: (path: string, meta: Schema.JsonObject, key?: string) =>
					write(messages.topic(caller, path, { meta }, key)),
			},
			emit: <E = never>(type: string, payload: Schema.JsonObject, change?: (seq: number) => Effect.Effect<void, E>) =>
				write(
					Effect.gen(function* () {
						const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
						return yield* messages
							.recordEvent(
								{
									transaction,
									type,
									level: "info",
									payload,
									actor: caller.agent,
									instance: caller.instance,
									request: caller.request,
								},
								change,
							)
							.pipe(Effect.provideService(Lifecycle, lifecycle), Effect.provideService(Crypto.Crypto, crypto));
					}),
				),
			read: messages.read,
		};
	};
});
export type ExtensionCapabilities = ReturnType<Effect.Success<typeof extensionCapabilities>>;
