import { mysqlSearchConfig } from "./mysql-search-config.ts";
import type { ExtensionCapabilities } from "../../kernel/extension-capabilities.ts";
import { markRead } from "./read-marks.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Pages } from "./pages.ts";
import type { Mutation } from "../../kernel/mutate.ts";
import { Publication } from "../../kernel/publication.ts";
import { Crypto, Deferred, Effect, Option, Ref, type Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { type MessageInput } from "@comms/protocol/messages";
import { makeMessages, validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";
import { HealthProbe } from "../../kernel/health-probe.ts";
import { Lifecycle, RequestMutation } from "../../kernel/lifecycle.ts";
import { makeTopics } from "./topics.ts";

/** Bind product operations to the caller; persistence stays in the shared mutation service. */
export const extensionCapabilities = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const publication = yield* Publication;
	const pages = yield* Pages;
	const crypto = yield* Crypto.Crypto;
	const lifecycle = yield* Lifecycle;
	const mysql = yield* mysqlSearchConfig(sql);
	return (extension: string, who?: Identity, writable = true): ExtensionCapabilities => {
		const caller = who ?? { agent: "system", instance: `extension:${extension}`, request: "", kind: "agent" };
		const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				if (!writable) return yield* new KernelError({ code: "scope_required" });
				// Guarded readiness owns the rollback-only transaction; the shared mutation protocol recognizes this probe.
				if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return yield* effect;
				const admitted = Option.getOrNull(yield* Effect.serviceOption(RequestMutation));
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
					return yield* new KernelError({ code: "input_invalid" });
				yield* Effect.acquireRelease(
					lifecycle.gate.withPermit(
						Effect.gen(function* () {
							const state = yield* Ref.get(lifecycle.state);
							if (state !== "live" && !(who && state === "accepted") && !(admitted && (yield* Ref.get(admitted))))
								return yield* new KernelError({ code: "generation_not_live" });
							yield* Ref.update(lifecycle.mutations, (count) => count + 1);
						}),
					),
					() => Ref.update(lifecycle.mutations, (count) => count - 1).pipe(Effect.andThen(lifecycle.activityChanged)),
				);
				return yield* effect;
			}).pipe(Effect.scoped, Effect.provideService(Lifecycle, lifecycle));

		const read = <A, E, R>(
			read: (fence: number) => Effect.Effect<A, E, R>,
		): Effect.Effect<A, E | KernelError | SqlError | Schema.SchemaError, R> =>
			publication.read(read).pipe(Effect.provideService(Lifecycle, lifecycle));
		const mutate = <A, E, R>(input: Effect.Effect<A, E, R> | Omit<Mutation<A, E, R>, "guard">) =>
			write(
				Effect.gen(function* () {
					if (Effect.isEffect(input)) return yield* publication.change(input);
					if ("guard" in input) return yield* new KernelError({ code: "input_invalid" });
					if (
						input.idempotency &&
						(input.idempotency.instance !== caller.instance || input.idempotency.scope !== undefined)
					)
						return yield* new KernelError({ code: "input_invalid" });
					return yield* publication.mutate({
						...(input.idempotency ? { idempotency: input.idempotency } : {}),
						body: (reserve) =>
							input
								.body(reserve)
								.pipe(
									Effect.flatMap((result) =>
										result.events.some(
											(event) =>
												event.actor !== caller.agent ||
												event.instance !== caller.instance ||
												event.request_id !== caller.request ||
												event.generation !== boot.generation,
										)
											? Effect.fail(new KernelError({ code: "input_invalid" }))
											: Effect.succeed(result),
									),
								),
					});
				}),
			);
		const messages = makeMessages(sql, { read, mutate }, boot, crypto, mysql);
		const topics = makeTopics(sql, read, pages);
		return {
			generation: boot.generation,
			events: { query: boot.events, changed: boot.changed },
			drained: Deferred.await(lifecycle.drained),
			mutate,
			read,
			messages: {
				query: (input: Parameters<typeof messages.list>[0]) =>
					messages.list(input).pipe(Effect.provideService(Lifecycle, lifecycle)),
				create: (input: typeof MessageInput.Type, key?: string) => messages.create(caller, input, key),
			},
			topics: {
				read: (path: string, options: { readonly depth?: number; readonly archived?: boolean } = {}) =>
					topics
						.detail(caller, path, options.depth, options.archived)
						.pipe(Effect.provideService(Lifecycle, lifecycle)),
				meta: (path: string, meta: Schema.JsonObject, key?: string) => messages.topic(caller, path, { meta }, key),
				// Viewing with read scope may mark only this context's instance, and never an unpublished sequence.
				markRead: (path: string, seq: number) =>
					lifecycle.gate
						.withPermit(
							Effect.gen(function* () {
								if (path === "") return;
								const state = yield* Ref.get(lifecycle.state);
								if (state !== "live" && state !== "accepted") return;
								if (!validTopic(path) || !Number.isSafeInteger(seq) || seq < 0)
									return yield* new KernelError({ code: "input_invalid" });
								if (seq > (yield* publication.fence).published_through)
									return yield* new KernelError({ code: "cursor_ahead" });
								yield* markRead(sql, publication.mutate, caller, { topic: path, seq });
							}),
						)
						.pipe(Effect.provideService(Lifecycle, lifecycle)),
			},
			emit: <E = never>(type: string, payload: Schema.JsonObject, change?: (seq: number) => Effect.Effect<void, E>) =>
				write(
					Effect.gen(function* () {
						const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
						return yield* publication
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
		};
	};
});
