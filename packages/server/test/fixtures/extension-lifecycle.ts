import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Config, Console, Effect, Ref, FileSystem, Layer, Path, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
import { layer as messagesLayer } from "../../src/kernel/messages.ts";
import { Lifecycle, layer as lifecycleLayer, type State } from "../../src/kernel/lifecycle.ts";
import { Extensions, layer as extensionsLayer } from "../../src/kernel/ext.ts";

const run = Effect.gen(function* () {
	const directory = yield* Config.String("EXTENSION_DIRECTORY");
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const record = path.join(directory, "record.txt");
	return yield* Effect.gen(function* () {
		const extensions = yield* Extensions;
		const lifecycle = yield* Lifecycle;
		const changeState = (state: State) =>
			Ref.set(lifecycle.state, state).pipe(Effect.andThen(extensions.changeState(state)));
		const read = () =>
			fs.exists(record).pipe(Effect.flatMap((exists) => (exists ? fs.readFileString(record) : Effect.succeed(""))));
		const trace: string[] = [];
		for (const state of [
			"rehearsal",
			"candidate",
			"accepted",
			"live",
			"live",
			"frozen",
			"live",
			"draining",
		] satisfies ReadonlyArray<Parameters<Extensions["Service"]["changeState"]>[0]>) {
			yield* changeState(state);
			trace.push(yield* read());
		}
		yield* changeState("live");
		yield* extensions.dispatch(Effect.succeed(HttpServerResponse.empty())).pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(
					new Request("http://localhost/api/failure", {
						headers: {
							"x-comms-agent": "test",
							"x-comms-instance": "instance",
							"x-comms-request-id": "request",
							"x-comms-auth-kind": "agent",
							"x-comms-scopes": "read",
						},
					}),
				),
			),
			Effect.forkScoped,
		);
		while (!(yield* read()).endsWith("closing,")) yield* Effect.sleep("5 millis");
		yield* changeState("frozen");
		trace.push(yield* read());
		yield* Console.log(
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
				trace,
				status: yield* extensions.status,
				diagnostics: yield* extensions.diagnostics,
			}),
		);
	}).pipe(Effect.provide(extensionsLayer(directory).pipe(Layer.provide(messagesLayer))));
}).pipe(
	Effect.scoped,
	Effect.provideService(BootChannel, {
		agents: Effect.succeed({ items: [] }),
		epoch: "test",
		filename: ":memory:",
		generation: 1,
		fence: Effect.succeed({ published_through: 0 }),
		events: (input) => Effect.succeed({ items: [], cursor: input.since, timed_out: false, drained: false }),
		reserve: (transaction, count) => Effect.succeed({ transaction, from: 1, to: count }),
		abort: () => Effect.void,
		append: () => Effect.succeed({ published_through: 0 }),
	}),
	Effect.provide(Layer.mergeAll(lifecycleLayer, SqliteClient.layer({ filename: ":memory:" }), BunServices.layer)),
);
run.pipe(BunRuntime.runMain);
