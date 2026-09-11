import { Effect } from "effect";
import { KernelError } from "./boot-channel.ts";
import type { Api } from "./extension-api.ts";
import { work } from "./extension-work.ts";

/** Human page responses share route validation and retain the boot-verified auth kind. */
export const pageHandler =
	(handler: Parameters<Api["page"]>[1]): Parameters<Api["route"]>[2]["handler"] =>
	(_request, context) =>
		Effect.gen(function* () {
			if (context.kind !== "human") return yield* new KernelError({ code: "scope_required" });
			const result = yield* work(() => handler(context));
			return typeof result === "string"
				? new Response(result, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"cache-control": "no-store",
							"x-content-type-options": "nosniff",
						},
					})
				: result;
		});
