import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { MessagePatch } from "./message-patch.ts";
import { Message } from "./messages.ts";
const params = { ref: Schema.String };
const query = Schema.Record(Schema.String, Schema.Never);
export const messageGroup = HttpApiGroup.make("message")
	.add(
		HttpApiEndpoint.patch("update", "/api/messages/:ref", {
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			params,
			query,
			payload: MessagePatch.annotate({ parseOptions: { onExcessProperty: "error" } }),
			success: Message,
		}).annotate(
			OpenApi.Description,
			"Edit body, tags or meta by m_ id or bare sequence. Requires write and the author's instance or a human. Success follows durable message.edited publication; Idempotency-Key preserves the first outcome.",
		),
		HttpApiEndpoint.delete("remove", "/api/messages/:ref", {
			headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
			error: errorSchemas,
			params,
			query,
			success: Message,
		}).annotate(
			OpenApi.Description,
			"Soft-delete by m_ id or bare sequence. Requires write and the author's instance or a human. Returns the tombstone after durable publication; Idempotency-Key preserves the first outcome.",
		),
	)
	.middleware(RequestValidation);
