import { Api as CoreApi, coreHandlers } from "./core/api.ts";
import type { Api } from "../kernel/extension-api.ts";

/** Core owns the product routes; later extensions can replace them through the same API. */
export default function core(api: Api) {
	api.mount(CoreApi, coreHandlers(api));
}
