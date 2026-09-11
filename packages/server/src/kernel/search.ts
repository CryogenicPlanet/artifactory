import { Context, Effect, Layer } from "effect";
import { KernelError } from "./boot-channel.ts";
import { Messages, validTopic } from "./messages.ts";

export type SearchInput = {
	readonly q: string;
	readonly topic?: string;
	readonly since: number;
	readonly limit: number;
};
const make = Effect.gen(function* () {
	const messages = yield* Messages;
	return {
		find: (input: SearchInput) =>
			Effect.gen(function* () {
				if (
					!Number.isSafeInteger(input.since) ||
					input.since < 0 ||
					!Number.isSafeInteger(input.limit) ||
					input.limit < 1 ||
					input.limit > 200 ||
					(input.topic !== undefined && !validTopic(input.topic))
				)
					return yield* new KernelError({ code: "query_invalid" });
				return yield* messages.list({ ...input, recursive: true });
			}),
	};
});
/** Full-text search over published message bodies, including archived topics.
 * Never match an edit or deletion before its corresponding event is published. */
export class Search extends Context.Service<Search, Effect.Success<typeof make>>()("comms/server/Search") {}
export const layer = Layer.effect(Search, make);
