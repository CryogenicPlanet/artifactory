import { Cause, Effect, Schema, type Scope } from "effect";

import { KernelError } from "./boot-channel.ts";

export type Work<A, R = never> = Effect.Effect<A, unknown, Scope.Scope | R> | Promise<A>;

export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", {
	message: Schema.String,
}) {}
export const work = <A, R = never, E = never>(
	run: () => Work<A, R> | A,
	drainPromise = false,
	onSuccess: Effect.Effect<void, E> = Effect.void,
): Effect.Effect<A, ExtensionError | KernelError, Scope.Scope | R> =>
	/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Normalize unknown errors from user-authored effects at this boundary. */
	Effect.suspend(() => {
		const result = run();
		return Effect.isEffect(result)
			? result.pipe(Effect.tap(onSuccess))
			: result instanceof Promise
				? Effect.tryPromise(() => result).pipe(
						Effect.tap(onSuccess),
						drainPromise ? Effect.uninterruptible : (effect) => effect,
					)
				: Effect.succeed(result).pipe(Effect.tap(onSuccess));
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.failCause(
				Cause.map(cause, (error) =>
					Schema.is(KernelError)(error) ? error : new ExtensionError({ message: Cause.pretty(Cause.fail(error)) }),
				),
			),
		),
	);
/* oxlint-enable effecttsgo/any-unknown-in-error-context */
