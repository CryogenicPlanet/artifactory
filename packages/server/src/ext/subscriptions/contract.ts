import { Schema } from "effect";
const validTopic = (topic: string) =>
	topic.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(topic);

export class SubscriptionError extends Schema.TaggedError<SubscriptionError>()("SubscriptionError", {
	code: Schema.Literals([
		"input_invalid",
		"idempotency_conflict",
		"event_cursor_invalid",
		"subscription_limit",
		"subscription_not_found",
		"subscription_unavailable",
		"webhook_response_too_large",
	]),
}) {}
const Filter = Schema.Struct({
	topic: Schema.optionalKey(Schema.String),
	types: Schema.optionalKey(Schema.Array(Schema.String)),
	agent: Schema.optionalKey(Schema.String),
});
export const Input = Schema.Struct({
	filter: Filter,
	deliver: Schema.Struct({ kind: Schema.Literal("webhook"), url: Schema.String }),
});
export type Input = typeof Input.Type;
export const Stored = Schema.Struct({
	id: Schema.String,
	instance: Schema.String,
	agent: Schema.String,
	human: Schema.Int,
	input: Schema.fromJsonString(Input),
	idempotency_key: Schema.NullOr(Schema.String),
	created_at: Schema.Int,
	start_seq: Schema.Int,
	created_seq: Schema.Int,
	deleted_seq: Schema.NullOr(Schema.Int),
	cursor: Schema.Int,
	attempts: Schema.Int,
	next_attempt: Schema.Int,
	last_error: Schema.NullOr(Schema.String),
});
export type Stored = typeof Stored.Type;
export const validate = (input: Input): Input => {
	const url = new URL(input.deliver.url);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.hash ||
		input.deliver.url.length > 2048
	)
		throw new SubscriptionError({ code: "input_invalid" });
	const { filter } = input;
	if (
		(filter.topic !== undefined && !validTopic(filter.topic)) ||
		(filter.agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(filter.agent)) ||
		(filter.types !== undefined &&
			(filter.types.length === 0 ||
				filter.types.length > 32 ||
				filter.types.join(",").length > 512 ||
				filter.types.some((t) => !/^(?:[a-zA-Z0-9_.-]+\*?|\*)$/.test(t))))
	)
		throw new SubscriptionError({ code: "input_invalid" });
	return {
		filter: {
			...(filter.topic === undefined ? {} : { topic: filter.topic }),
			types: filter.types === undefined ? ["message.created"] : [...new Set(filter.types)].sort(),
			...(filter.agent === undefined ? {} : { agent: filter.agent }),
		},
		deliver: { kind: "webhook", url: url.href },
	};
};
export const created = (row: Stored) => ({
	id: row.id,
	filter: row.input.filter,
	deliver: row.input.deliver,
	created_at: row.created_at,
	since: row.start_seq,
});
