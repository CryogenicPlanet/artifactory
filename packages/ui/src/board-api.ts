import { Cause, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { ErrorEnvelope, policy, type Message, type TopicResult } from "@comms/protocol";

export type BoardMessage = typeof Message.Type;
export type BoardTopic = typeof TopicResult.Type;
export type PendingMessage = { readonly topic: string; readonly body: string; readonly key: string };
export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
	status: Schema.Int,
	message: Schema.String,
}) {}
export const boardFailure = <E>(cause: Cause.Cause<E>): BoardError => {
	const error = Cause.squash(cause);
	if (Schema.is(BoardError)(error)) return error;
	if (Schema.is(ErrorEnvelope)(error)) {
		const code = error.error.code;
		return new BoardError({
			status: code === "store_unavailable" ? 503 : code === "handler_failed" ? 500 : policy[code].status,
			message: error.error.message,
		});
	}
	if (HttpClientError.isHttpClientError(error) && "response" in error.reason) {
		const status = error.reason.response.status;
		return new BoardError({
			status,
			message:
				status === 401
					? "Your session expired. Sign in again."
					: "The board could not complete this request. Try refreshing.",
		});
	}
	return new BoardError({
		status: 0,
		message: "The board could not confirm this request. Check your connection and try again.",
	});
};
export const topicHref = (path: string) => (path ? `/t/${path.split("/").map(encodeURIComponent).join("/")}` : "/");
export const validTopic = (path: string) =>
	path.length <= 200 && /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(path);
