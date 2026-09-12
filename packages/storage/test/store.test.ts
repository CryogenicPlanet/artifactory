import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { childStore, parse, render } from "../src/store.ts";

it("round trips absolute POSIX filenames without interpreting URL characters", async () => {
	for (const filename of ["/data/store/comms.db", "/tmp/a b/é?#%.db", "/tmp/日本語.db", "/tmp/100%25.db"]) {
		const store = { _tag: "file", filename } as const;
		expect(await Effect.runPromise(parse(Redacted.value(await Effect.runPromise(render(store)))))).toEqual(store);
		expect(JSON.stringify(await Effect.runPromise(render(store)))).not.toContain(filename);
	}
});
it("refuses malformed descriptors and unsupported engines without exposing input", async () => {
	for (const raw of [
		"app.db",
		"file:app.db",
		"file://host/db",
		"file:///db",
		"file:/",
		"file:/a?mode=ro",
		"file:/a#fragment",
		"file:/a/../db",
		"file:/a/%2e%2e/db",
		"file:/a//db",
		"file:/a%00db",
		"file:/%ZZ",
		"file:/a\\db",
	]) {
		const result = await Effect.runPromise(parse(raw).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "store_descriptor_invalid" } });
	}
	for (const raw of ["postgres://user:secret@host/db", "mysql://user:secret@host/db"]) {
		const result = await Effect.runPromise(parse(raw).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "store_engine_unsupported" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
});
it("requires the legacy alias to identify exactly the selected file", async () => {
	expect(await Effect.runPromise(childStore("file:/tmp/a%20b.db", "/tmp/a b.db"))).toEqual({
		_tag: "file",
		filename: "/tmp/a b.db",
	});
	expect(await Effect.runPromise(childStore("file:/tmp/a.db", "/tmp/b.db").pipe(Effect.result))).toMatchObject({
		_tag: "Failure",
		failure: { code: "store_descriptor_mismatch" },
	});
	expect(await Effect.runPromise(childStore("mysql://secret@host/db", "/tmp/a.db").pipe(Effect.result))).toMatchObject({
		_tag: "Failure",
		failure: { code: "store_engine_unsupported" },
	});
});

it("refuses unrenderable paths as typed failures", async () => {
	for (const filename of [
		"relative.db",
		"/tmp/a\tb.db",
		"/tmp/a\\b.db",
		"/tmp/a\u0000b.db",
		"/tmp/\ud800",
		"/tmp/../a.db",
	]) {
		expect(await Effect.runPromise(render({ _tag: "file", filename }).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "store_descriptor_invalid" },
		});
	}
});

it("supports an old image alias without permitting missing or conflicting selection", async () => {
	expect(await Effect.runPromise(childStore(undefined, "/tmp/a b.db"))).toEqual({
		_tag: "file",
		filename: "/tmp/a b.db",
	});
	for (const [raw, legacy, variable] of [
		[undefined, undefined, "APP_STORE"],
		[undefined, "relative.db", "APP_DATABASE"],
		["file:/a/../b", "/b", "APP_STORE"],
	] as const) {
		const result = await Effect.runPromise(childStore(raw, legacy).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "store_descriptor_invalid", variable } });
	}
});
