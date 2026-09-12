import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Cause, ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { remoteOptions } from "../src/kernel/remote-database.ts";
import { BootChannel, layer as channelLayer } from "../src/kernel/boot-channel.ts";

const settings = () => ({
	REMOTE_ATTEMPT: "a".repeat(64),
	REMOTE_GUARDIAN_URL: "http://127.0.0.1:12345",
	REMOTE_GUARDIAN_SECRET: "b".repeat(64),
	DATABASE_TLS: "false",
});

it.effect("requires complete local guardian configuration without echoing invalid secrets", () =>
	Effect.gen(function* () {
		for (const overrides of [
			{ REMOTE_GUARDIAN_URL: "https://remote.invalid/secret" },
			{ REMOTE_GUARDIAN_URL: "http://127.0.0.1:0" },
			{ REMOTE_GUARDIAN_SECRET: "private-value" },
			{ REMOTE_ATTEMPT: "private-value" },
			{ DATABASE_TLS: "private-value" },
			{ REMOTE_ATTEMPT: undefined },
			{ REMOTE_GUARDIAN_URL: undefined },
			{ REMOTE_GUARDIAN_SECRET: undefined },
			{ DATABASE_TLS: undefined },
		]) {
			const result = yield* remoteOptions.pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...settings(), ...overrides }))),
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.make(() => Effect.die("unexpected request")),
				),
				Effect.exit,
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				const text = Cause.pretty(result.cause);
				expect(text).toContain("remote_configuration_invalid");
				expect(text).not.toContain("private-value");
			}
		}
	}),
);

it.effect("accepts only a guardian 204 acknowledgement and sanitizes refusals", () =>
	Effect.gen(function* () {
		for (const status of [204, 200, 302, 403, 500]) {
			const client = HttpClient.make((request, url) => {
				expect(url.href).toBe("http://127.0.0.1:12345/register");
				expect(request.headers["x-comms-guardian-secret"]).toBe("b".repeat(64));
				expect(request.method).toBe("POST");
				return Effect.succeed(
					HttpClientResponse.fromWeb(request, new Response(status === 204 ? null : "private-response", { status })),
				);
			});
			const options = yield* remoteOptions.pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings()))),
				Effect.provideService(HttpClient.HttpClient, client),
			);
			const result = yield* options
				.register({ engine: "pg", server: "server", database: "app", username: "app", connectionId: "42", tag: "tag" })
				.pipe(Effect.exit);
			expect(result._tag).toBe(status === 204 ? "Success" : "Failure");
			if (result._tag === "Failure") expect(Cause.pretty(result.cause)).not.toContain("private-response");
		}
	}),
);

it.effect("remote channels expose no filename and refuse the legacy database alias", () =>
	Effect.gen(function* () {
		for (const legacy of [false, true]) {
			const result = yield* BootChannel.pipe(
				Effect.provide(channelLayer),
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.make(() => Effect.die("unexpected request")),
				),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							WRITER_EPOCH: "epoch",
							APP_STORE: "postgres://app:password@localhost/app",
							GENERATION: "1",
							STATE: "rehearsal",
							REHEARSAL_SEQUENCE: "1",
							...(legacy ? { APP_DATABASE: "/old.db" } : {}),
						}),
					),
				),
				Effect.result,
			);
			expect(result._tag).toBe(legacy ? "Failure" : "Success");
			if (result._tag === "Success") {
				expect(result.success.filename).toBeNull();
				expect(result.success.store._tag).toBe("postgres");
			}
		}
	}),
);

// These tests exercise guardian IPC only; SQLite runtime coverage runs in real Bun children.
vi.mock("@comms/storage/client", () => ({
	clientLayer: () => {
		throw new Error("Unexpected SQLite client construction");
	},
}));
