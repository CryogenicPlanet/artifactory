import { layer as durableEventsLayer } from "../../src/events.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Crypto, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { Events, layer as eventsLayer } from "../../src/events.ts";
import { backupRoute } from "../../src/backup-http.ts";
import { eventRoute, type Attempt } from "../../src/event-http.ts";
import { sessionCookie } from "../../src/auth-http.ts";
import { ArtifactRetentionRejected } from "../../src/artifact-retention.ts";
import type { Destination } from "../../src/traffic.ts";
import { makeBackupInventory } from "../../src/backup-inventory.ts";
import type { DatabaseBackup } from "../../src/database-backup.ts";
import { StorageRejected } from "../../src/storage-headroom.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const program = Effect.gen(function* () {
	const filename = process.argv[2];
	if (!filename) return yield* Effect.die("Missing database");
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const session = "b".repeat(43);
		const hash = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(session))).toString("hex");
		yield* sql`INSERT INTO passkeys(id,public_key,counter,transports,label,created_at) VALUES('fixture','unused',0,'[]','fixture',1)`;
		yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('fixture',${hash},1,9999999999999)`;
		yield* Effect.gen(function* () {
			const auth = yield* Auth;
			const inventory = yield* makeBackupInventory;
			const events = yield* Events;
			const gate = yield* Semaphore.make(1);
			const route = yield* Ref.make<Destination | null>(null);
			const attempts = yield* Ref.make<readonly Attempt[]>([
				{ secret: "attempt-secret", epoch: "epoch", host: "localhost", generation: 1, state: "live" },
			]);
			for (const error of [
				new StorageRejected({ code: "storage_headroom" }),
				new StorageRejected({ code: "storage_measurement_failed" }),
				new ArtifactRetentionRejected({ code: "backup_budget" }),
				new ArtifactRetentionRejected({ code: "invalid_storage_sample" }),
				new ArtifactRetentionRejected({ code: "unsafe_artifact_path" }),
			]) {
				for (const mixed of [false, true]) {
					const capture: DatabaseBackup = {
						capture: () =>
							Effect.fail(error).pipe(Effect.ensuring(mixed ? Effect.die("backup finalizer failed") : Effect.void)),
					};
					for (const internal of [false, true]) {
						const request = HttpServerRequest.fromWeb(
							new Request("http://localhost/_boot/db/backup", {
								method: "POST",
								body: "{}",
								headers: {
									host: "localhost",
									"content-type": "application/json",
									...(internal
										? { "x-boot-secret": "attempt-secret" }
										: { cookie: `${sessionCookie}=${session}`, origin: "https://comms.test" }),
								},
							}),
						);
						const response = yield* (
							internal
								? eventRoute(events, attempts, null, gate, route, Effect.succeed(true), capture)
								: backupRoute(auth, inventory, capture)
						).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
						assert.ok(response);
						assert.equal(
							response.status,
							mixed
								? 500
								: error.code === "unsafe_artifact_path"
									? 409
									: error.code === "storage_measurement_failed"
										? 503
										: 507,
						);
						const body = yield* HttpServerResponse.toClientResponse(response).json.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Struct({ error: Schema.Struct({ code: Schema.String, retriable: Schema.Boolean }) }),
								),
							),
						);
						assert.equal(body.error.code, mixed ? "handler_failed" : error.code);
						assert.equal(body.error.retriable, !mixed && error.code === "storage_measurement_failed");
					}
				}
			}
		}).pipe(
			Effect.provide(
				authLayer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
					Layer.provideMerge(Layer.mergeAll(eventsLayer(Effect.void), lockLayer)),
				),
			),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })));
	yield* Console.log("BACKUP_REFUSAL_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
