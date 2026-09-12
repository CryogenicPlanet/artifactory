import { ConfigProvider, Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { databaseConfiguration } from "../src/database-configuration.ts";

const selected = (env: Readonly<Record<string, string>>) =>
	databaseConfiguration("/data/boot.db", "/data/app.db").pipe(
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
	);

it("keeps the default SQLite selections when both remote URLs are absent", async () => {
	expect(await Effect.runPromise(selected({}))).toEqual({
		_tag: "file",
		boot: { _tag: "file", filename: "/data/boot.db" },
		app: { _tag: "file", filename: "/data/app.db" },
	});
});

it.for(["postgres", "mysql"])(
	"pairs %s roles without forwarding the app password into boot's app connection",
	async (scheme) => {
		const config = await Effect.runPromise(
			selected({
				DATABASE_URL: `${scheme}://app:app-secret@localhost/app`,
				BOOT_DATABASE_URL: `${scheme}://boot:boot-secret@localhost/boot`,
			}),
		);
		if (config._tag !== "remote") throw new Error("Expected remote pair");
		expect(config.bootAppConnection.database).toBe("app");
		expect(config.bootAppConnection.username).toBe("boot");
		expect(Redacted.value(config.bootAppConnection.password)).toBe("boot-secret");
		expect(config.appConnection.username).toBe("app");
		expect(config.appConnection.tls).toBe(true);
		expect(JSON.stringify(config)).not.toContain("secret");
	},
);

it("refuses incomplete, conflicting, cross-server and shared-role configurations", async () => {
	for (const env of [
		{ DATABASE_URL: "postgres://app:secret@db/app" },
		{ BOOT_DATABASE_URL: "postgres://boot:secret@db/boot" },
		{ DATABASE_URL: "postgres://app:secret@db/app", BOOT_DATABASE_URL: "mysql://boot:secret@db/boot" },
		{ DATABASE_URL: "postgres://app:secret@db/app", BOOT_DATABASE_URL: "postgres://boot:secret@other/boot" },
		{ DATABASE_URL: "postgres://app:secret@db/app", BOOT_DATABASE_URL: "postgres://app:secret@db/boot" },
		{ DATABASE_URL: "postgres://app:secret@db/app", BOOT_DATABASE_URL: "postgres://boot:secret@db/app" },
		{ DATABASE_URL: "file:/data/same.db", BOOT_DATABASE_URL: "file:/data/same.db" },
	]) {
		const result = await Effect.runPromise(selected(env).pipe(Effect.result));
		expect(result._tag).toBe("Failure");
		expect(JSON.stringify(result)).not.toContain("secret");
	}
});
