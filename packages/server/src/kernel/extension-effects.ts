import { Effect, Fiber, Ref, type Schema, type Scope } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type { Lifecycle, State } from "./lifecycle.ts";

export interface SuppressedEffect {
	readonly extension: string;
	readonly kind: "fetch" | "notify" | "timer" | "cron";
	readonly reason: State | "inactive";
	readonly method?: string;
	readonly destination?: string;
	readonly delay_ms?: number;
	readonly expression?: string;
}
export interface SuppressionReport {
	readonly records: ReadonlyArray<SuppressedEffect>;
	readonly overflow: number;
}
const suppressed = { status: "suppressed" } as const;
const origin = (url: string) => {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin.slice(0, 256) : "invalid";
	} catch {
		return "invalid";
	}
};

/** Admission owns only the fork, never network work: freeze can always close the scope. */
export const makeExtensionEffects = (
	extension: string,
	lifecycle: Pick<Lifecycle["Service"], "state" | "gate">,
	activeScope: Ref.Ref<Scope.Closeable | null>,
) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const report = yield* Ref.make<SuppressionReport>({ records: [], overflow: 0 });
		const record = (metadata: Omit<SuppressedEffect, "extension" | "reason">, reason: SuppressedEffect["reason"]) =>
			Ref.update(report, (value) =>
				value.records.length < 64
					? { ...value, records: [...value.records, { extension: extension.slice(0, 128), ...metadata, reason }] }
					: { ...value, overflow: Math.min(Number.MAX_SAFE_INTEGER, value.overflow + 1) },
			);
		const allowed = (scope: Scope.Closeable) =>
			Effect.gen(function* () {
				return (yield* Ref.get(lifecycle.state)) === "live" && (yield* Ref.get(activeScope)) === scope;
			});
		const admit = <A, E, R>(
			metadata: Omit<SuppressedEffect, "extension" | "reason">,
			task: (scope: Scope.Closeable) => Effect.Effect<A, E, R>,
		) =>
			lifecycle.gate.withPermit(
				Effect.gen(function* () {
					const state = yield* Ref.get(lifecycle.state);
					const scope = yield* Ref.get(activeScope);
					if (state !== "live" || !scope) {
						yield* record(metadata, state === "live" ? "inactive" : state);
						return null;
					}
					return yield* Effect.gen(function* () {
						if (!(yield* allowed(scope))) return yield* Effect.interrupt;
						return yield* task(scope);
					}).pipe(Effect.forkIn(scope));
				}),
			);
		const send = <A, E, R>(
			kind: "fetch" | "notify",
			request: HttpClientRequest.HttpClientRequest,
			consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
		) =>
			Effect.acquireUseRelease(
				admit({ kind, method: request.method.slice(0, 16), destination: origin(request.url) }, () =>
					Effect.scoped(HttpClient.withScope(client).execute(request).pipe(Effect.flatMap(consume))).pipe(
						Effect.interruptible,
					),
				),
				(fiber) =>
					Effect.gen(function* () {
						if (!fiber) return suppressed;
						return { status: "sent", value: yield* Fiber.join(fiber) } as const;
					}),
				(fiber) => (fiber ? Fiber.interrupt(fiber) : Effect.void),
			);
		return {
			report: Ref.get(report),
			recordCron: (expression: string) =>
				Effect.gen(function* () {
					const state = yield* Ref.get(lifecycle.state);
					if (state !== "live") yield* record({ kind: "cron", expression: expression.slice(0, 128) }, state);
				}),
			fetch: <A, E, R>(
				request: HttpClientRequest.HttpClientRequest,
				consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
			) => send("fetch", request, consume),
			notify: (url: string, json: Schema.Json) =>
				Effect.gen(function* () {
					const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), json);
					const result = yield* send("notify", request, () => Effect.void);
					return result.status === "suppressed" ? suppressed : ({ status: "sent" } as const);
				}),
			timer: <E, R>(delayMs: number, callback: Effect.Effect<void, E, R>) =>
				Effect.gen(function* () {
					if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647)
						return yield* Effect.die(
							new Error("Timer delay must be an integer between 0 and 2147483647 milliseconds."),
						);
					const fiber = yield* admit({ kind: "timer", delay_ms: delayMs }, (scope) =>
						Effect.gen(function* () {
							yield* Effect.sleep(delayMs);
							if (!(yield* allowed(scope))) return yield* Effect.interrupt;
							yield* callback;
						}),
					);
					return fiber ? ({ status: "scheduled" } as const) : suppressed;
				}),
		};
	});

export type ExtensionEffects = Effect.Success<ReturnType<typeof makeExtensionEffects>>;
