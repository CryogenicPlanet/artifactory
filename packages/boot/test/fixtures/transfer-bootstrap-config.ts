import { BunServices } from "@effect/platform-bun";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { parseDescriptor } from "@comms/storage/store";
import { Context, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const Connection = Schema.Struct({
	engine: Schema.Literal("mysql"),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
export const bootstrapConfiguration = Effect.gen(function* () {
	const [directory, phase, dataDirectory] = process.argv.slice(2);
	if (!directory || !dataDirectory || (phase !== "create" && phase !== "insert" && phase !== "positive"))
		return yield* Effect.die("Invalid bootstrap fixture arguments");
	const fs = yield* FileSystem.FileSystem;
	const family = `${phase}2`;
	const read = (suffix: string) =>
		fs
			.readFileString(`${directory}/mysql-bootstrap-${family}-${suffix}.json`)
			.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Connection))));
	const boot = yield* read("boot"),
		app = yield* read("app"),
		writer = yield* read("boot-app");
	if (
		boot.database !== `comms_transfer_bootstrap_${family}_boot` ||
		app.database !== `comms_transfer_bootstrap_${family}_app` ||
		writer.database !== app.database ||
		writer.username !== boot.username ||
		app.username === boot.username
	)
		return yield* Effect.die("Nonfixture database refused");
	const descriptor = (value: typeof Connection.Type) =>
		`mysql://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port}/${value.database}`;
	return {
		boot,
		app,
		writer,
		dataDirectory,
		bootStore: yield* parseDescriptor(descriptor(boot)),
		appStore: yield* parseDescriptor(descriptor(app)),
		bootUrl: descriptor(boot),
		appUrl: descriptor(app),
	};
});
export const openBootstrapClient = (settings: typeof Connection.Type) =>
	Effect.gen(function* () {
		const connection = { ...settings, password: Redacted.make(settings.password), tls: false };
		const attempt = Buffer.from(yield* (yield* Crypto.Crypto).randomBytes(32)).toString("hex");
		const context = yield* Layer.build(
			remoteClientLayer({ connection, attempt, register: () => Effect.void }).pipe(
				Layer.provide(remoteInspectorLayer({ connection, attempt })),
			),
		);
		return Context.get(context, SqlClient.SqlClient);
	});
export const bootstrapServices = BunServices.layer;
