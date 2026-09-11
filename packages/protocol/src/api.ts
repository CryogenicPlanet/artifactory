import { extGroup } from "./extensions.ts";
import { HttpApi } from "effect/unstable/httpapi";
import { boundedConversationGroup } from "./conversation.ts";
import { topicsGroup } from "./topics-http.ts";
import { topicManagementGroup } from "./topic-management-http.ts";
import { messageGroup } from "./message-http.ts";
import { profilesGroup } from "./profiles-http.ts";
import { streamGroup } from "./stream-http.ts";
export const CoreApi = HttpApi.make("comms")
	.add(topicsGroup)
	.add(topicManagementGroup)
	.add(messageGroup)
	.add(profilesGroup)
	.add(streamGroup)
	.add(boundedConversationGroup);

export const Api = CoreApi.add(extGroup);
