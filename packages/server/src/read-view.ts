import { Effect, Ref } from "effect";
import { Lifecycle } from "./kernel/lifecycle.ts";
import { Messages, type Message, type Identity } from "./kernel/messages.ts";

/** Frozen reads stay available; metadata writes join the same gate as freeze. */
export const markView = (who: Identity, items: ReadonlyArray<typeof Message.Type>, topic: string, enabled = true) =>
	Effect.gen(function* () {
		if (!enabled || items.length === 0) return;
		const lifecycle = yield* Lifecycle;
		const messages = yield* Messages;
		yield* lifecycle.gate.withPermit(
			Effect.gen(function* () {
				const state = yield* Ref.get(lifecycle.state);
				if (state !== "live" && state !== "accepted") return;
				yield* messages.mark(who, { topic, seq: Math.max(...items.map((message) => message.seq)) });
			}),
		);
	});
