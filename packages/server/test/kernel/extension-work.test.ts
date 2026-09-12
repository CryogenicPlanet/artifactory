import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { KernelError } from "../../src/kernel/boot-channel.ts";
import { work, ExtensionError } from "../../src/kernel/extension-work.ts";

it.effect("preserves typed failures alongside defects and interruption at the extension boundary", () =>
	Effect.gen(function* () {
		const expected = Cause.fail(new KernelError({ code: "boot_unavailable" }));
		for (const cause of [
			expected,
			Cause.combine(expected, Cause.die("unexpected defect")),
			Cause.combine(expected, Cause.interrupt()),
		]) {
			const exit = yield* Effect.exit(work(() => Effect.failCause(cause)));
			expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual(cause.reasons);
		}
		const unknown = yield* Effect.exit(work(() => Effect.fail("extension failure")));
		expect(Exit.isFailure(unknown) && unknown.cause.reasons).toEqual([
			expect.objectContaining({ _tag: "Fail", error: expect.any(ExtensionError) }),
		]);
	}),
);
