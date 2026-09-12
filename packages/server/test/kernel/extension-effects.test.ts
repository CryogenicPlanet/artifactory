import { createServer } from "node:http";
import { it, expect } from "vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeExtensionEffects } from "../../src/kernel/extension-effects.ts";
import type { State } from "../../src/kernel/lifecycle.ts";

const setup = (state: State) =>
	Effect.gen(function* () {
		const lifecycle = { state: yield* Ref.make(state), gate: yield* Semaphore.make(1) };
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const active = yield* Ref.make<Scope.Closeable | null>(scope);
		const helper = yield* makeExtensionEffects("alpha", lifecycle, active);
		const freeze = lifecycle.gate
			.withPermit(Ref.set(lifecycle.state, "frozen"))
			.pipe(Effect.andThen(Ref.set(active, null)), Effect.andThen(Scope.close(scope, Exit.void)));
		return { lifecycle, active, helper, freeze };
	});

it("suppresses real HTTP traffic, redacts destinations, bounds and isolates reports", async () => {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const url = `http://127.0.0.1:${address.port}`;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { helper, lifecycle, active } = yield* setup("rehearsal");
					const other = yield* makeExtensionEffects("beta", lifecycle, active);
					expect(
						yield* helper.fetch(HttpClientRequest.get(`${url}/secret?token=secret`), (response) => response.text),
					).toEqual({
						status: "suppressed",
					});
					expect(yield* helper.notify(`${url}/notify`, { secret: "hidden" })).toEqual({ status: "suppressed" });
					for (const state of ["candidate", "frozen"] as const) {
						yield* Ref.set(lifecycle.state, state);
						expect(yield* helper.timer(0, Effect.die("must not run"))).toEqual({ status: "suppressed" });
					}
					for (let index = 0; index < 70; index++)
						yield* helper.fetch(
							HttpClientRequest.get("https://user:password@example.com/private?secret=yes"),
							(response) => response.text,
						);
					const report = yield* helper.report;
					expect(report.records).toHaveLength(64);
					expect(report.overflow).toBe(10);
					expect(JSON.stringify(report)).not.toMatch(/secret|password|private|user:/);
					expect(report.records[0]?.destination).toBe(url);
					expect(yield* other.report).toEqual({ records: [], overflow: 0 });
					expect(requests).toBe(0);
					yield* Ref.set(lifecycle.state, "live");
					expect((yield* helper.fetch(HttpClientRequest.get(url), (response) => response.text)).status).toBe("sent");
					expect(yield* helper.notify(url, { hello: "world" })).toEqual({ status: "sent" });
					expect(requests).toBe(2);
				}),
			).pipe(Effect.provide(FetchHttpClient.layer)),
		);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

it("runs scoped timers and cancels pending timers on freeze, including escaped effects", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { helper, freeze } = yield* setup("live");
				const fired = yield* Deferred.make<void>();
				expect(yield* helper.timer(0, Deferred.succeed(fired, undefined))).toEqual({ status: "scheduled" });
				yield* Deferred.await(fired);
				const calls = yield* Ref.make(0);
				const escaped = helper.timer(
					0,
					Ref.update(calls, (value) => value + 1),
				);
				yield* helper.timer(
					100,
					Ref.update(calls, (value) => value + 1),
				);
				yield* freeze;
				expect(yield* escaped).toEqual({ status: "suppressed" });
				yield* Effect.sleep(120);
				expect(yield* Ref.get(calls)).toBe(0);
			}),
		).pipe(Effect.provide(FetchHttpClient.layer)),
	);
});

it("freeze and caller cancellation abort in-flight HTTP fibers", async () => {
	for (const cancel of ["freeze", "caller"] as const) {
		let received: () => void = () => {};
		let closed: () => void = () => {};
		const arrived = new Promise<void>((resolve) => {
			received = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const server = createServer((_request, response) => {
			response.on("close", closed);
			response.writeHead(200);
			response.write("partial");
			received();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing listener");
			const url = `http://127.0.0.1:${address.port}`;
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { helper, freeze } = yield* setup("live");
						const reading = yield* Deferred.make<void>();
						const fiber = yield* helper
							.fetch(HttpClientRequest.get(url), (response) =>
								Deferred.succeed(reading, undefined).pipe(Effect.andThen(response.text)),
							)
							.pipe(Effect.forkScoped);
						yield* Effect.promise(() => arrived);
						yield* Deferred.await(reading);
						if (cancel === "freeze") yield* freeze;
						else yield* Fiber.interrupt(fiber);
						expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
						yield* Effect.promise(() => aborted);
					}),
				).pipe(Effect.provide(FetchHttpClient.layer)),
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
});

it("cancels a running timer callback and refuses live admission without an active scope", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { helper, active, freeze, lifecycle } = yield* setup("live");
				const started = yield* Deferred.make<void>();
				const stopped = yield* Deferred.make<void>();
				yield* helper.timer(
					0,
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(Deferred.succeed(stopped, undefined)),
					),
				);
				yield* Deferred.await(started);
				yield* freeze;
				yield* Deferred.await(stopped);
				yield* Ref.set(lifecycle.state, "live");
				expect(yield* Ref.get(active)).toBeNull();
				expect(yield* helper.timer(0, Effect.die("unreachable"))).toEqual({ status: "suppressed" });
				expect((yield* helper.report).records[0]?.reason).toBe("inactive");
				expect(Exit.isFailure(yield* Effect.exit(helper.timer(2_147_483_648, Effect.void)))).toBe(true);
			}),
		).pipe(Effect.provide(FetchHttpClient.layer)),
	);
});
