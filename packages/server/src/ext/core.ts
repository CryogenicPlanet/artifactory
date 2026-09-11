import { CoreApi } from "@comms/protocol";
import { Config, Effect, Layer } from "effect";
import { coreHandlers } from "./core/api.ts";
import { layer as pagesLayer } from "./core/pages.ts";
import type { Api } from "../kernel/extension-api.ts";

/** Core owns the product routes; later extensions can replace them through the same API. */
export default function core(api: Api) {
	api.mount(
		CoreApi,
		coreHandlers(api).pipe(Layer.provide(Layer.unwrap(Config.String("PAGES_DIRECTORY").pipe(Effect.map(pagesLayer))))),
	);
}
