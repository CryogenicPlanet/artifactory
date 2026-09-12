import { Config, Effect, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";
import { KernelError } from "./kernel/boot-channel.ts";

const Manifest = Schema.Struct({
	endpoints: Schema.Record(Schema.String, Schema.JsonObject),
	components: Schema.Struct({ securitySchemes: Schema.JsonObject }),
});

/** Discovery is requested only by a reader, never during candidate or rehearsal startup. */
export const liveDiscovery = (specification: OpenAPISpec) =>
	Effect.gen(function* () {
		const url = yield* Config.String("BOOT_URL");
		const client = yield* HttpClient.HttpClient;
		// Public metadata needs no caller credentials or child channel secret.
		const response = yield* client.get(`${url}/.well-known/agent.json`);
		if (response.status !== 200) return yield* new KernelError({ code: "boot_unavailable" });
		const manifest = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
		return {
			...specification,
			paths: { ...specification.paths, ...manifest.endpoints },
			components: {
				...specification.components,
				securitySchemes: { ...specification.components.securitySchemes, ...manifest.components.securitySchemes },
			},
		};
	}).pipe(
		Effect.timeout("1500 millis"),
		Effect.mapError(() => new KernelError({ code: "boot_unavailable" })),
	);
