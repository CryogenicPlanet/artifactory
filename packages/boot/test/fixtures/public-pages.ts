import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, FileSystem, Fiber, Layer, Ref, Schema, Semaphore } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../src/events.ts";
import { PublicPages, layer } from "../../src/public-pages.ts";
import type { Destination } from "../../src/traffic.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing directory");
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(`${root}/pages/guide`, { recursive: true });
	yield* fs.writeFileString(`${root}/pages/guide/file.md`, "# Guide");
	let denied = false;
	const app = yield* Effect.acquireRelease(
		Effect.sync(() =>
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (
						request.headers.get("x-boot-secret") !== "fixture" ||
						Array.from(request.headers.keys()).some((name) => name.startsWith("x-comms-"))
					)
						return new Response(null, { status: 403 });
					const input = Schema.decodeUnknownSync(
						Schema.Struct({ paths: Schema.Array(Schema.String), published_through: Schema.Int }),
					)(await request.json());
					return Response.json(
						denied ? { allowed: false, code: "topic_deleted", path: input.paths[0] } : { allowed: true },
					);
				},
			}),
		),
		(server) => Effect.promise(() => server.stop(true)),
	);
	const route = yield* Ref.make<Destination | null>({
		secret: "fixture",
		epoch: "fixture",
		host: "127.0.0.1",
		generation: 1,
		state: "live",
		port: app.port ?? 0,
		pid: process.pid,
		snapshot: root,
	});
	const operationGate = yield* Semaphore.make(1),
		channelGate = yield* Semaphore.make(1);
	return yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO public_paths VALUES ('guide')`;
		const policy = yield* PublicPages.pipe(
			Effect.provide(layer(root, operationGate, channelGate, route).pipe(Layer.provide(eventsLayer(Effect.void)))),
		);
		const events = yield* Events.pipe(Effect.provide(eventsLayer(Effect.void)));
		yield* events.reserve("pending-page-admission", 1, "fixture");
		let writes = 0;
		const publish = Effect.sync(() => {
			writes++;
			return "published once";
		});
		const waiting = yield* policy.withWrite(["pages/guide/file.md"], publish).pipe(Effect.forkScoped);
		yield* Effect.sleep("30 millis");
		const beforeSettlement = writes;
		yield* channelGate.withPermit(events.abort("pending-page-admission", "fixture"));
		const settled = yield* Fiber.join(waiting);
		yield* events.reserve("stuck-page-admission", 1, "fixture");
		const stuck = yield* policy.withWrite(["pages/guide/file.md"], publish).pipe(Effect.result);
		yield* channelGate.withPermit(events.abort("stuck-page-admission", "fixture"));
		const initial = (yield* policy.check("/p/guide/file.md")) !== null;
		const held = yield* Deferred.make<void>(),
			release = yield* Deferred.make<void>();
		const owner = yield* operationGate
			.withPermit(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
			.pipe(Effect.forkScoped);
		yield* Deferred.await(held);
		const blocked = yield* policy.check("/p/guide/file.md").pipe(Effect.result);
		yield* Deferred.succeed(release, undefined);
		yield* Fiber.join(owner);
		const after = (yield* policy.check("/p/guide/file.md")) !== null;
		const writeHeld = yield* Deferred.make<void>(),
			writeRelease = yield* Deferred.make<void>();
		const writing = yield* policy
			.withWrite(
				["pages/guide/file.md"],
				Deferred.succeed(writeHeld, undefined).pipe(Effect.andThen(Deferred.await(writeRelease))),
			)
			.pipe(Effect.forkScoped);
		yield* Deferred.await(writeHeld);
		const reservation = yield* channelGate
			.withPermit(Effect.succeed("admitted"))
			.pipe(Effect.timeout("25 millis"), Effect.result);
		yield* Deferred.succeed(writeRelease, undefined);
		yield* Fiber.join(writing);
		denied = true;
		yield* sql`DELETE FROM public_paths`;
		const deleted = (yield* policy.check("/p/guide/file.md")) === null;
		const refused = yield* policy.withWrite(["pages/guide/new.md"], publish).pipe(Effect.result);
		const replacement = (yield* policy.check("/p/guide/file.md")) !== null;
		const missing = yield* policy.check("/p/guide/file.md").pipe(Effect.result);
		return {
			beforeSettlement,
			settled,
			writes,
			stuck: stuck._tag,
			initial,
			blocked: blocked._tag,
			after,
			reservation: reservation._tag,
			deleted,
			refused: refused._tag,
			replacement,
			missing: missing._tag,
			notCreated: !(yield* fs.exists(`${root}/comms.db`)),
		};
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.flatMap((value) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.flatMap(Console.log)),
	),
);
main.pipe(BunRuntime.runMain);
