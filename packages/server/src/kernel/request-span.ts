import { Context, Effect, Tracer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const RequestSpan = Context.Reference<Tracer.Span | undefined>("comms/RequestSpan", {
	defaultValue: () => undefined,
});

/** Handler-construction span, after attempt-secret verification. Boot owns stream lifetime;
 * annotations after response headers are committed cannot be returned to boot. */
export const requestSpan = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const trace = /^00-([a-f0-9]{32})-([a-f0-9]{16})-01$/.exec(request.headers["x-chirp-traceparent"] ?? "");
		if (!trace?.[1] || !trace[2] || /^0+$/.test(trace[1]) || /^0+$/.test(trace[2])) return yield* handler;
		const parent = Tracer.externalSpan({ traceId: trace[1], spanId: trace[2], sampled: true });
		return yield* Effect.gen(function* () {
			const span = yield* Effect.currentSpan;
			const response = yield* handler.pipe(Effect.provideService(RequestSpan, span));
			const fields: Record<string, string> = {};
			for (const key of ["topic", "message_id", "extension", "lock_state"]) {
				const value = span.attributes.get(key);
				if (typeof value === "string" && /^[a-zA-Z0-9@/_.:-]{1,200}$/.test(value)) fields[key] = value;
			}
			return HttpServerResponse.setHeader(response, "x-chirp-span", encodeURIComponent(JSON.stringify(fields)));
		}).pipe(Effect.withSpan("http.app", { parent }));
	});
