import { Effect } from "effect";
import type { Message } from "@comms/protocol/messages";

import type { RequestContext } from "../../kernel/extension-api.ts";

/** Core and third-party views use the same caller-bound automatic mark operation. */
export const markView = (
	ctx: Pick<RequestContext, "topics">,
	items: ReadonlyArray<typeof Message.Type>,
	topic: string,
	enabled = true,
) => {
	if (!enabled || topic === "") return Effect.void;
	const visible = items.filter((message) => message.topic === topic || message.topic.startsWith(`${topic}/`));
	return visible.length ? ctx.topics.markRead(topic, Math.max(...visible.map((message) => message.seq))) : Effect.void;
};
