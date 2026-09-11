import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Crypto, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { orientation } from "../src/onboarding.ts";
import { Topics } from "../src/kernel/topics.ts";
import { Pages } from "../src/kernel/pages.ts";

it.effect("bounds onboarding inbox work and explicitly labels an incomplete zero count", () =>
	Effect.gen(function* () {
		const response = yield* orientation(true, {}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.mock(Pages, { read: () => Effect.succeed("# Welcome"), render: (value) => value }),
					Layer.succeed(
						Crypto.Crypto,
						Crypto.make({
							randomBytes: (size) => new Uint8Array(size),
							digest: () => Effect.succeed(new Uint8Array(32)),
						}),
					),
					Layer.mock(Topics, {
						cursor: () => Effect.succeed(7),
						inbox: (_who, since, limit, mode, maxScan) =>
							Effect.sync(() => {
								expect({ since, limit, mode, maxScan }).toEqual({ since: 7, limit: 201, mode: "agent", maxScan: 2000 });
								return { items: [], cursor: since, timed_out: false, drained: false, scan_truncated: true };
							}),
						detail: () =>
							Effect.succeed({
								path: "",
								meta: {},
								archived_at: null,
								archived_by: null,
								subtopics: [],
								messages: [],
								cursor: 10,
								unread: 0,
								index: null,
								pages: [],
							}),
					}),
				),
			),
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(
					new Request("http://localhost/init.md", {
						headers: {
							"x-comms-auth-kind": "agent",
							"x-comms-agent": "codex",
							"x-comms-instance": "one",
							"x-comms-request-id": "test",
							"x-comms-scopes": "read",
						},
					}),
				),
			),
		);
		expect(response.status).toBe(200);
		if (response.body._tag !== "Uint8Array") return yield* Effect.die("Expected text response");
		expect(new TextDecoder().decode(response.body.body)).toContain("at least 0 (partial scan) unread inbox messages");
	}),
);
