import { clientLayer } from "@comms/storage/client";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { failure, sanitized, type RemoteSession } from "@comms/storage/remote-session";
import { connectionOf, type Store } from "@comms/storage/store";
import { Config, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

/** The guardian acknowledges each physical lease before app SQL can use it. */
export const remoteOptions = Effect.gen(function* () {
	const attempt = yield* Config.String("REMOTE_ATTEMPT");
	const url = yield* Config.String("REMOTE_GUARDIAN_URL");
	const secret = yield* Config.Redacted("REMOTE_GUARDIAN_SECRET");
	const tls = yield* Config.String("DATABASE_TLS");
	const match = /^http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(url);
	const port = Number(match?.[1]);
	if (
		!/^[a-f0-9]{64}$/.test(attempt) ||
		!/^[a-f0-9]{64}$/.test(Redacted.value(secret)) ||
		!match ||
		port < 1 ||
		port > 65535 ||
		(tls !== "true" && tls !== "false")
	)
		return yield* failure("remote_configuration_invalid");
	const client = yield* HttpClient.HttpClient;
	return {
		attempt,
		tls: tls === "true",
		register: (session: RemoteSession) =>
			sanitized(
				Effect.gen(function* () {
					const response = yield* client.execute(
						HttpClientRequest.post(`${url}/register`).pipe(
							HttpClientRequest.setHeader("x-comms-guardian-secret", Redacted.value(secret)),
							HttpClientRequest.bodyJsonUnsafe(session),
						),
					);
					if (response.status !== 204) return yield* failure("remote_registration_failed");
				}).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.timeout("5 seconds")),
				"remote_registration_failed",
			),
	};
}).pipe((effect) => sanitized(effect, "remote_configuration_invalid"));

export const databaseLayer = (store: Store) =>
	Layer.unwrap(
		Effect.gen(function* () {
			if (store._tag === "file") return clientLayer(store);
			const options = yield* remoteOptions;
			const connection = yield* connectionOf(store, options.tls);
			return guardianClientLayer({ connection, attempt: options.attempt, register: options.register });
		}),
	);
