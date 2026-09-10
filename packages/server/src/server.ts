import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

const routes = HttpRouter.add(
	"GET",
	"/",
	HttpServerResponse.text("comms server scaffold. Messaging, auth, storage, and reloads are not implemented.\n"),
);

const server = Effect.gen(function* () {
	const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080));
	return yield* routes.pipe(
		HttpRouter.serve,
		Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
		Layer.launch,
	);
});

server.pipe(BunRuntime.runMain);
