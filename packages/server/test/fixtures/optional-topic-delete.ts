import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { deleteTopic as remove } from "../../../../examples/extensions/topic-delete.ts";
import { Messages } from "../../src/ext/core/messages.ts";
import { Topics } from "../../src/ext/core/topics.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import type { Identity } from "../../src/kernel/identity.ts";

/** Retained fault harness exercises the relocated policy with its injected publication failure boundary. */
export const deleteTopic = (identity: Identity, path: string, key?: string) =>
	Effect.gen(function* () {
		const messages = yield* Messages,
			db = yield* SqlClient.SqlClient,
			boot = yield* BootChannel;
		const topics = yield* Effect.serviceOption(Topics);
		const installedLifecycle = yield* Effect.serviceOption(Lifecycle);
		const lifecycle = Option.isSome(installedLifecycle)
			? installedLifecycle.value
			: yield* Lifecycle.pipe(Effect.provide(lifecycleLayer));
		return yield* remove(
			{
				...identity,
				db,
				mutate: (input) =>
					(Effect.isEffect(input) ? messages.change(input) : messages.mutate(input)).pipe(
						Effect.scoped,
						Effect.provideService(Lifecycle, lifecycle),
					),
				generation: boot.generation,
				topics: {
					read: (path) =>
						Option.isSome(topics)
							? topics.value.detail(identity, path)
							: Effect.fail(new KernelError({ code: "topic_not_found" })),
				},
			},
			path,
			key,
		);
	});
