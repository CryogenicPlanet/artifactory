import { Clock, Effect, Ref, Schema, Stream, type Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Events } from "./events.ts";
import { recoveryIntents } from "./recovery-intents.ts";
import { SourceRejected } from "./source-schema.ts";
import type { Destination } from "./traffic.ts";

class PagePolicyUnavailable extends Schema.TaggedError<PagePolicyUnavailable>()("PagePolicyUnavailable", {}) {}
const Decision = Schema.Union([
	Schema.Struct({ allowed: Schema.Literal(true) }),
	Schema.Struct({
		allowed: Schema.Literal(false),
		code: Schema.Literals(["topic_deleted", "topic_archived"]),
		path: Schema.String,
	}),
]);

/** Boot retains journal ordering; the selected app decides whether these published page paths are writable. */
export const pageWriteAdmission = (
	operationGate: Semaphore.Semaphore,
	channelGate: Semaphore.Semaphore,
	route: Ref.Ref<Destination | null>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const client = yield* HttpClient.HttpClient;
		const policy = (names: readonly string[], published: number) =>
			Effect.gen(function* () {
				const destination = yield* Ref.get(route);
				if (!destination) return yield* new PagePolicyUnavailable({});
				let offset = 0;
				while (offset < names.length) {
					const paths: string[] = [];
					let size = 0;
					while (offset < names.length && paths.length < 256) {
						const name = names[offset];
						if (name === undefined) break;
						const bytes = Buffer.byteLength(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(name)) + 1;
						if (bytes > 524288) return yield* new PagePolicyUnavailable({});
						if (size + bytes > 524288) break;
						paths.push(name);
						size += bytes;
						offset++;
					}
					const decision = yield* Effect.gen(function* () {
						const response = yield* client.execute(
							HttpClientRequest.post(`http://127.0.0.1:${destination.port}/_kernel/pages/check`).pipe(
								HttpClientRequest.setHeader("x-boot-secret", destination.secret),
								HttpClientRequest.bodyJsonUnsafe({ paths, published_through: published }),
							),
						);
						if (response.status !== 200) return yield* new PagePolicyUnavailable({});
						let received = 0;
						const chunks = yield* response.stream.pipe(
							Stream.tap((chunk) =>
								Effect.gen(function* () {
									received += chunk.byteLength;
									if (received > 65536) return yield* new PagePolicyUnavailable({});
								}),
							),
							Stream.runCollect,
						);
						return yield* Schema.decodeEffect(Schema.fromJsonString(Decision))(Buffer.concat(chunks).toString("utf8"));
					}).pipe(
						Effect.timeout("1 second"),
						Effect.catchCause(() => Effect.fail(new PagePolicyUnavailable({}))),
					);
					if (!decision.allowed) {
						if (!paths.includes(decision.path)) return yield* new PagePolicyUnavailable({});
						return yield* new SourceRejected({ code: decision.code, path: decision.path });
					}
				}
			});
		return <A, E, R>(names: readonly string[], effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const deadline = (yield* Clock.monotonicTimeNanos) + 1_000_000_000n;
				while (true) {
					const admitted = yield* operationGate.withPermit(
						channelGate.withPermit(
							Effect.gen(function* () {
								if ((yield* recoveryIntents(sql)).count > 0) return yield* new PagePolicyUnavailable({});
								const state = yield* events.state;
								if (state.pending_id !== null) return null;
								// The app reads its published policy independently; it must never call this held event channel.
								yield* policy(names, state.published_through);
								return { value: yield* effect };
							}),
						),
					);
					if (admitted !== null) return admitted.value;
					if ((yield* Clock.monotonicTimeNanos) >= deadline) return yield* new PagePolicyUnavailable({});
					// Release both gates so a pending outbox can settle. Only admission repeats, never publication.
					yield* Effect.sleep("10 millis");
				}
			});
	});
