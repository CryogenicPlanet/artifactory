import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { accountPost, accountRequest } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";
import { getEditLock } from "./extension-api.ts";
import { BoardError } from "./board-api.ts";

export const breakEditLock = (id: string) =>
	Effect.gen(function* () {
		const body = { id };
		const proof = yield* confirmAccountAction("lock.break", body);
		yield* accountRequest(
			HttpClientRequest.delete(new URL("/_boot/lock?break=1", window.location.origin).href).pipe(
				HttpClientRequest.bodyJsonUnsafe(body),
				HttpClientRequest.setHeader("x-comms-assertion", proof),
			),
		);
	});
const Outcome = Schema.Struct({
	generation: Schema.Int,
	status: Schema.Literals(["live", "failed"]),
	error: Schema.optionalKey(Schema.String),
});
export const revertSource = (key: string) =>
	Effect.gen(function* () {
		const lock = yield* getEditLock;
		if (lock === null)
			// 423 means someone else holds it; 503 means it was taken but recovery still needs repair,
			// which carries lock_committed. Either way, re-read and proceed if the lock is ours now.
			yield* accountPost("/_boot/lock", {}).pipe(
				Effect.catchTag("BoardError", (error) =>
					error.status === 423 || error.status === 503
						? getEditLock.pipe(Effect.flatMap((current) => (current ? Effect.void : Effect.fail(error))))
						: Effect.fail(error),
				),
			);
		return yield* accountRequest(
			HttpClientRequest.post(new URL("/_boot/revert", window.location.origin).href).pipe(
				HttpClientRequest.bodyJsonUnsafe({}),
				HttpClientRequest.setHeader("Idempotency-Key", key),
			),
			120000,
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Outcome)),
			Effect.catchTag("SchemaError", () =>
				Effect.fail(
					new BoardError({
						status: 0,
						message: "The revert response was unreadable. Check boot status before starting another undo.",
					}),
				),
			),
		);
	});
