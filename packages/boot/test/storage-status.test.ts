import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

const Status = Schema.Struct({
	storage: Schema.Struct({
		sampled_at: Schema.NullOr(Schema.Int),
		status: Schema.String,
		volume: Schema.NullOr(Schema.Unknown),
		allocated: Schema.Array(Schema.Struct({ category: Schema.String, bytes: Schema.NullOr(Schema.Int) })),
	}),
});

it("serves cached storage only after status authentication, including while the child is down", async (test) => {
	const app = await launch(test, "exit");
	const read = async () =>
		Schema.decodeUnknownSync(Status)(await (await app.fetch(`${app.url}/_boot/status`)).json()).storage;
	expect((await fetch(`${app.url}/_boot/status`)).status).toBe(401);
	await expect.poll(async () => (await read()).sampled_at).not.toBeNull();
	const measured = await read();
	expect(["available", "partial"]).toContain(measured.status);
	expect(measured.allocated).toHaveLength(11);
	await writeFile(join(app.data, "comms.db.restore"), Buffer.alloc(16384));
	for (let attempt = 0; attempt < 3; attempt++) expect(await read()).toEqual(measured);
	expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
});
