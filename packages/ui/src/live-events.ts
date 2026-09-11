import { ErrorEnvelope, EventRecord } from "@comms/protocol";
import { Effect, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { Reactivity } from "effect/unstable/reactivity";

/** One stream per mounted browser provider. Request diagnostics never invalidate their own reads. */
export const liveEvents = Effect.gen(function* () {
	const cursor = yield* Ref.make<string | undefined>(undefined);
	const reactivity = yield* Reactivity.Reactivity;
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			const foreground = () => {
				if (document.visibilityState === "visible") reactivity.invalidateUnsafe(["board", "extensions", "identity"]);
			};
			document.addEventListener("visibilitychange", foreground);
			return () => document.removeEventListener("visibilitychange", foreground);
		}),
		(remove) => Effect.sync(remove),
	);
	const connect = Effect.gen(function* () {
		const last = yield* Ref.get(cursor);
		const request = HttpClientRequest.get(new URL("/api/stream", window.location.origin).href).pipe(
			HttpClientRequest.setUrlParam("types", "message.*,topic.*,page.*,fs.*,generation.*,ext.*,lock.*"),
		);
		const response = yield* HttpClient.execute(
			last === undefined ? request : HttpClientRequest.setHeader(request, "Last-Event-ID", last),
		);
		// Re-read after connecting, including the first connection, to cover the snapshot/stream handoff.
		yield* Reactivity.invalidate(["board", "extensions", "identity"]);
		if (response.status !== 200) {
			const error = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ErrorEnvelope)), Effect.option);
			if (error._tag === "Some" && error.value.error.code === "cursor_ahead") yield* Ref.set(cursor, undefined);
			return;
		}
		yield* response.stream.pipe(
			Stream.decodeText(),
			Stream.pipeThroughChannel(Sse.decode()),
			Stream.runForEach((event) =>
				Effect.gen(function* () {
					if (event.id !== undefined && /^[0-9]+$/.test(event.id)) yield* Ref.set(cursor, event.id);
					const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EventRecord))(event.data);
					if (/^(message|topic|page|fs)\./.test(body.type)) yield* Reactivity.invalidate(["board"]);
					else if (/^(generation|ext|lock)\./.test(body.type))
						yield* Reactivity.invalidate(["board", "extensions", "identity"]);
				}),
			),
		);
	}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
	// A brief offline interval need not fail fetch's existing stream. Reconnect explicitly on online
	// so bytes missed during that interval are replayed from the last processed event.
	const online = Effect.callback<void>((resume) => {
		const connected = () => resume(Effect.void);
		window.addEventListener("online", connected);
		return Effect.sync(() => window.removeEventListener("online", connected));
	});
	while (true) {
		yield* Effect.raceFirst(connect, online).pipe(
			Effect.catchCause(() => Reactivity.invalidate(["board", "extensions", "identity"])),
		);
		yield* Effect.sleep("2 seconds");
	}
});
