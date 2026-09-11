import { Effect, Ref } from "effect";
import { type EventRecord } from "@comms/protocol/events";
import { type BootChannel, KernelError } from "./boot-channel.ts";

export interface EventHook<E> {
	readonly type: string;
	readonly handle: (event: typeof EventRecord.Type) => Effect.Effect<void, E>;
}

/** A generation-local cursor survives canceled freezes, but is not a durable delivery receipt. */
export const runEvents = <E>(
	read: BootChannel["Service"]["events"],
	cursor: Ref.Ref<number>,
	hooks: ReadonlyArray<EventHook<E>>,
	admit: Effect.Effect<void, KernelError>,
) =>
	Effect.gen(function* () {
		while (true) {
			const since = yield* Ref.get(cursor);
			// Read failures are transport failures, not extension defects. Leave the cursor unchanged.
			const result = yield* read({ since, limit: 100, types: [...new Set(hooks.map((hook) => hook.type))] }).pipe(
				Effect.result,
			);
			if (result._tag === "Failure") {
				yield* Effect.sleep("1 second");
				continue;
			}
			const page = result.success;
			if (!Number.isSafeInteger(page.cursor) || page.cursor < since)
				return yield* new KernelError({ code: "event_cursor_invalid" });
			let previous = since;
			for (const event of page.items) {
				if (!Number.isSafeInteger(event.seq) || event.seq <= previous || event.seq > page.cursor)
					return yield* new KernelError({ code: "event_cursor_invalid" });
				previous = event.seq;
			}
			for (const event of page.items) {
				for (const hook of hooks) {
					if (
						hook.type !== "*" &&
						hook.type !== event.type &&
						!(hook.type.endsWith("*") && event.type.startsWith(hook.type.slice(0, -1)))
					)
						continue;
					yield* admit;
					yield* hook.handle(event);
				}
				// Commit only after every callback succeeded. Interruption/failure may replay this event.
				yield* Ref.set(cursor, event.seq);
			}
			// Exhausted filtered pages also acknowledge sequence values that did not match.
			yield* Ref.set(cursor, page.cursor);
			if (page.items.length === 0) yield* Effect.sleep("100 millis");
		}
	});
