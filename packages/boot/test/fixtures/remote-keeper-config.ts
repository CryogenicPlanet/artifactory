import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { asBoot, connectionOf, parseDescriptor } from "@comms/storage/store";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const descriptor = async (filename: string) => {
	const value = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
	return `${value.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port}/${encodeURIComponent(value.database)}`;
};
export const configuration = Effect.gen(function* () {
	const appFile = process.env.COMMS_REMOTE_TEST_CONFIG;
	const bootFile = process.env.COMMS_REMOTE_BOOT_TEST_CONFIG;
	if (!appFile || !bootFile) throw new Error("Missing protected remote test configuration");
	const app = yield* parseDescriptor(yield* Effect.promise(() => descriptor(appFile)));
	const boot = yield* parseDescriptor(yield* Effect.promise(() => descriptor(bootFile)));
	if (app._tag === "file" || boot._tag === "file") throw new Error("Expected remote configuration");
	const bootApp = yield* asBoot(app, boot);
	return {
		_tag: "remote" as const,
		app,
		boot,
		bootApp,
		appConnection: yield* connectionOf(app, false),
		bootConnection: yield* connectionOf(boot, false),
		bootAppConnection: yield* connectionOf(bootApp, false),
	};
});
