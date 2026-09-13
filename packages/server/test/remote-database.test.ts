import { it } from "@effect/vitest";
import { expect } from "vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { BootChannel, layer as channelLayer } from "../src/kernel/boot-channel.ts";

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
