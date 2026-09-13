import { extGroup } from "./extensions.ts";
import { HttpApi } from "effect/unstable/httpapi";
import { boundedConversationGroup } from "./conversation.ts";
import { topicsGroup, rootTopic } from "./topics-http.ts";
import { topicManagementGroup } from "./topic-management-http.ts";
import { messageGroup } from "./message-http.ts";
import { profilesGroup } from "./profiles-http.ts";
import { eventsGroup } from "./events-http.ts";
import { streamGroup } from "./stream-http.ts";
const common = HttpApi.make("chirp")
	.add(topicManagementGroup)
	.add(messageGroup)
	.add(profilesGroup)
	.add(streamGroup)
	.add(eventsGroup)
	.add(boundedConversationGroup);

export const CoreApi = common.add(topicsGroup);
export const Api = common.add(topicsGroup.add(rootTopic)).add(extGroup);
