import { Effect } from "effect";
import type { Message } from "./messages.ts";
import type { RequestContext } from "../../kernel/extension-api.ts";

/** Core and third-party views use the same caller-bound automatic mark operation. */
export const markView = (
	ctx: Pick<RequestContext, "topics">,
	items: ReadonlyArray<typeof Message.Type>,
	topic: string,
	enabled = true,
) =>
	enabled && items.length ? ctx.topics.markRead(topic, Math.max(...items.map((message) => message.seq))) : Effect.void;
