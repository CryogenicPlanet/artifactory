import { CoreApi, coreHandlers } from "../conversation.ts";
import type { Api } from "../kernel/extension-api.ts";

/** Removing this extension removes the product routes; later extensions may replace any of them. */
export default function core(api: Api) {
	api.mount(CoreApi, coreHandlers);
}
