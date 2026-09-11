import { Clock, Effect, Stream } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { VerifiedIdentity } from "./enrollment.ts";
import { EventError, type Events } from "./events.ts";

const integer = (value: string | null, fallback: number, maximum: number) => {
	if (value === null) return fallback;
	if (!/^[0-9]+$/.test(value)) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number <= maximum ? number : null;
};

/** Boot-owned delivery reads each page through the caller's admission gate.
 * No permit or child lifetime is retained while waiting for another event. */
export const publicEventResponse = (
	request: HttpServerRequest.HttpServerRequest,
	identity: VerifiedIdentity | null,
	query: Events["Service"]["query"],
	changed: (after: number) => Effect.Effect<number, EventError>,
) =>
	Effect.gen(function* () {
		const url = new URL(request.url, "http://localhost");
		const sse = url.pathname.endsWith("/stream");
		const params = url.searchParams;
		const allowed = ["since", "limit", "topic", "types", "agent", "instance", "level", ...(sse ? [] : ["wait"])];
		if (
			url.search.length > 4096 ||
			[...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)
		)
			return yield* new EventError({ code: "query_invalid" });
		const cursorText = params.get("since") ?? (sse ? (request.headers["last-event-id"] ?? null) : null);
		const since = cursorText === null ? undefined : integer(cursorText, 0, Number.MAX_SAFE_INTEGER);
		const limit = integer(params.get("limit"), 100, 200);
		const wait = integer(params.get("wait"), 0, 60);
		const topic = params.get("topic"),
			types = params.get("types"),
			agent = params.get("agent"),
			instance = params.get("instance"),
			level = params.get("level");
		if (
			since === null ||
			limit === null ||
			limit < 1 ||
			wait === null ||
			(topic !== null &&
				(topic.length > 200 ||
					!/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(topic) ||
					topic.split("/").some((part) => part === "." || part === ".."))) ||
			(types !== null &&
				(types.length > 512 ||
					types.split(",").length > 32 ||
					types.split(",").some((type) => !/^(?:[a-zA-Z0-9_.-]+\*?|\*)$/.test(type)))) ||
			(agent !== null && (agent.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(agent))) ||
			(instance !== null && (instance.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(instance))) ||
			(level !== null && !["debug", "info", "warn", "error"].includes(level))
		)
			return yield* new EventError({ code: "query_invalid" });
		const input = {
			limit,
			...(since === undefined ? {} : { since }),
			...(identity?.kind === "agent" ? { requestActor: identity.agent } : {}),
			...(!sse && wait > 0 && identity ? { excludeMessageInstance: identity.id } : {}),
			...(topic === null ? {} : { topic }),
			...(types === null ? {} : { types: types.split(",") }),
			...(agent === null ? {} : { agent }),
			...(instance === null ? {} : { instance }),
			...(level === null ? {} : { level }),
		};
		const first = yield* query(input);
		const headers = { "cache-control": "no-store", "x-accel-buffering": "no" };
		if (!sse && (first.items.length > 0 || wait === 0)) return HttpServerResponse.jsonUnsafe(first, { headers });
		const encoder = new TextEncoder();
		const startedAt = yield* Clock.currentTimeMillis;
		const expiry = identity?.expiresAt;
		const awaitExpiry = Effect.gen(function* () {
			if (expiry === undefined) return yield* Effect.never;
			yield* Effect.sleep(Math.max(0, expiry - (yield* Clock.currentTimeMillis)));
		});
		if (sse) {
			const pages = Stream.unfold(first, (page) =>
				Effect.gen(function* () {
					if (page.items.length === 0) yield* changed(page.cursor);
					const next = yield* query({ ...input, since: page.cursor });
					return [next.items, next] as const;
				}),
			).pipe(Stream.flatMap((items) => Stream.fromIterable(items)));
			const events = Stream.concat(Stream.fromIterable(first.items), pages).pipe(
				Stream.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
				Stream.catchCause(() => Stream.empty),
			);
			return HttpServerResponse.stream(
				Stream.merge(
					events.pipe(Stream.interruptWhen(awaitExpiry)),
					Stream.tick("10 seconds").pipe(Stream.map(() => ": heartbeat\n\n")),
					{
						haltStrategy: "left",
					},
				).pipe(Stream.map((text) => encoder.encode(text))),
				{ contentType: "text/event-stream", headers },
			);
		}
		let current = first;
		const deadline = Math.min(startedAt + wait * 1000, expiry ?? Infinity);
		const expiresFirst = expiry !== undefined && expiry <= startedAt + wait * 1000;
		const poll = Effect.gen(function* () {
			while (true) {
				yield* changed(current.cursor);
				current = yield* query({ ...input, since: current.cursor });
				if (current.items.length > 0) return current;
			}
		});
		const result = Effect.gen(function* () {
			return yield* poll.pipe(
				Effect.timeoutOrElse({
					duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
					orElse: () => Effect.succeed({ ...current, timed_out: !expiresFirst, drained: expiresFirst }),
				}),
			);
		}).pipe(Effect.catchCause(() => Effect.succeed({ ...current, items: [], timed_out: false, drained: true })));
		return HttpServerResponse.stream(
			Stream.merge(
				Stream.fromEffect(result).pipe(Stream.map((value) => JSON.stringify(value))),
				Stream.tick("10 seconds").pipe(Stream.map(() => "\n")),
				{ haltStrategy: "left" },
			).pipe(Stream.map((text) => encoder.encode(text))),
			{ contentType: "application/json", headers },
		);
	});
