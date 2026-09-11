import { Clock, Deferred, Effect, Fiber, Stream } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { expect, it } from "vitest";
import type { VerifiedIdentity } from "../src/enrollment.ts";
import { EventError, type Events } from "../src/events.ts";
import { publicEventResponse } from "../src/public-event-http.ts";

const request = (path: string) => HttpServerRequest.fromWeb(new Request(`http://localhost${path}`));
const page = (cursor: number) => ({ items: [], cursor, timed_out: false, drained: false });
const identity = (expiresAt: number): VerifiedIdentity => ({
	id: "caller",
	agent: "codex",
	kind: "agent",
	label: "test",
	scopes: ["read"],
	expiresAt,
});

it("waits without querying, advances filtered cursors, and finishes JSON after a wait failure", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const signal = yield* Deferred.make<number, EventError>();
			const nextWait = yield* Deferred.make<void>();
			let queries = 0;
			const cursors: number[] = [];
			const query: Events["Service"]["query"] = () => Effect.sync(() => page(queries++ === 0 ? 0 : 5));
			const response = yield* publicEventResponse(request("/api/events?since=0&wait=5"), null, query, (cursor) =>
				Effect.gen(function* () {
					cursors.push(cursor);
					if (cursor === 0) return yield* Deferred.await(signal);
					yield* Deferred.succeed(nextWait, undefined);
					return yield* new EventError({ code: "events_unavailable" });
				}),
			);
			if (response.body._tag !== "Stream") throw new Error("Expected streaming body");
			const reading = yield* response.body.stream.pipe(Stream.runCollect, Effect.orDie, Effect.forkChild);
			yield* Effect.sleep("250 millis");
			expect(queries).toBe(1);
			yield* Deferred.succeed(signal, 5);
			yield* Deferred.await(nextWait);
			const chunks = yield* Fiber.join(reading);
			expect(queries).toBe(2);
			expect(cursors).toEqual([0, 5]);
			return Buffer.concat(chunks).toString();
		}),
	);
	expect(JSON.parse(result)).toEqual({ ...page(5), drained: true });
});

it("returns the latest filtered cursor at its long-poll deadline", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			let queries = 0;
			const response = yield* publicEventResponse(
				request("/api/events?since=0&wait=1"),
				null,
				() => Effect.sync(() => page(queries++ === 0 ? 0 : 4)),
				(cursor) => (cursor === 0 ? Effect.succeed(4) : Effect.never),
			);
			if (response.body._tag !== "Stream") throw new Error("Expected streaming body");
			const chunks = yield* Stream.runCollect(response.body.stream.pipe(Stream.orDie));
			expect(queries).toBe(2);
			return Buffer.concat(chunks).toString();
		}),
	);
	expect(JSON.parse(result)).toEqual({ ...page(4), timed_out: true });
});

it("finishes idle long-poll bodies when the captured credential expires", async () => {
	for (const path of ["/api/events?wait=60"]) {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				let interrupted = false;
				let queries = 0;
				const response = yield* publicEventResponse(
					request(path),
					identity((yield* Clock.currentTimeMillis) + 100),
					() => Effect.sync(() => page(++queries)),
					() =>
						Effect.never.pipe(
							Effect.ensuring(
								Effect.sync(() => {
									interrupted = true;
								}),
							),
						),
				);
				if (response.body._tag !== "Stream") throw new Error("Expected streaming body");
				const chunks = yield* Stream.runCollect(response.body.stream.pipe(Stream.orDie));
				expect(interrupted).toBe(true);
				expect(queries).toBe(1);
				return Buffer.concat(chunks).toString();
			}).pipe(Effect.timeout("2 seconds")),
		);
		expect(JSON.parse(result)).toEqual({ ...page(1), drained: true });
	}
});

it("finishes a valid drained envelope on a post-header defect", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const response = yield* publicEventResponse(
				request("/api/events?wait=1"),
				null,
				() => Effect.succeed(page(9)),
				() => Effect.die("unavailable store"),
			);
			if (response.body._tag !== "Stream") throw new Error("Expected streaming body");
			return Buffer.concat(yield* Stream.runCollect(response.body.stream.pipe(Stream.orDie))).toString();
		}),
	);
	expect(JSON.parse(result)).toEqual({ ...page(9), drained: true });
});
