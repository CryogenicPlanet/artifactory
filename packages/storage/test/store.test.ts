import { inspect } from "node:util";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { asBoot, childStore, parse, parseDescriptor, render, withDatabase } from "../src/store.ts";

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

const remote = (raw: string) =>
	Effect.runPromise(
		parseDescriptor(raw).pipe(
			Effect.flatMap((store) =>
				store._tag === "file" ? Effect.die("expected remote descriptor") : Effect.succeed(store),
			),
		),
	);

it("parses remote database names while keeping credentials redacted", async () => {
	for (const scheme of ["postgres", "postgresql", "mysql"]) {
		const store = await remote(`${scheme}://app:password%40secret@db:5432/board%20one`);
		expect(store._tag).toBe(scheme === "mysql" ? "mysql" : "postgres");
		expect(store.database).toBe("board one");
		expect(await remote(Redacted.value(await Effect.runPromise(render(store))))).toEqual(store);
		for (const representation of [JSON.stringify(store), inspect(store)]) {
			expect(representation).not.toContain("password");
			expect(representation).not.toContain("secret");
		}
	}
	expect(await Effect.runPromise(parseDescriptor("file:/tmp/board.db"))).toEqual({
		_tag: "file",
		filename: "/tmp/board.db",
	});
});

it("rejects ambiguous remote locations and malformed URLs without exposing credentials", async () => {
	for (const location of [
		"postgres://app:secret@db",
		"postgres://app:secret@db/",
		"postgres://app:secret@db/a/b",
		"postgres://app:secret@db/a?",
		"postgres://app:secret@db/a?schema=app",
		"postgres://app:secret@db/a#",
		"postgres://app:secret@db/..",
		"postgres://app:secret@db/%2e%2e",
		"postgres://app:secret@db/a%2fb",
		"postgres://app:secret@db/a%00b",
		"postgres://app:secret@db/%ZZ",
		"postgres://app:%ZZ@db/a",
		"postgres://app:secret@db/a\\b",
		"postgres://app:secret@db/a b",
		"postgres://app:secret@db:99999/a",
		"postgres://app:secret@/a",
		"https://app:secret@db/a",
	]) {
		const result = await Effect.runPromise(parseDescriptor(location).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "store_descriptor_invalid" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
});

it("changes only the database on an immutable remote descriptor", async () => {
	const source = await remote("postgres://app:private%40password@[::1]:5432/board");
	const clone = await Effect.runPromise(withDatabase(source, "rehearsal #1"));
	expect(source.database).toBe("board");
	expect(clone.database).toBe("rehearsal #1");
	expect(Redacted.value(await Effect.runPromise(render(clone)))).toBe(
		"postgres://app:private%40password@[::1]:5432/rehearsal%20%231",
	);
	for (const database of ["", ".", "..", "a/b", "a\\b", "a\u0000b"]) {
		expect(await Effect.runPromise(withDatabase(source, database).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "store_descriptor_invalid" },
		});
	}
});

it("derives the app database with only matching-endpoint boot credentials", async () => {
	for (const scheme of ["postgres", "mysql"]) {
		const port = scheme === "postgres" ? 5432 : 3306;
		const app = await remote(`${scheme}://app:app-password@DB/app`);
		const boot = await remote(`${scheme}://boot:boot-password@db:${port}/boot`);
		const selected = await Effect.runPromise(asBoot(app, boot));
		expect(selected.database).toBe("app");
		expect(Redacted.value(await Effect.runPromise(render(selected)))).toBe(
			`${scheme}://boot:boot-password@db:${port}/app`,
		);
		for (const other of [
			`${scheme}://boot:secret@other/boot`,
			`${scheme}://boot:secret@db:1234/boot`,
			`${scheme}://boot:secret@db/app`,
			`${scheme === "mysql" ? "postgres" : "mysql"}://boot:secret@db/boot`,
		]) {
			expect(await Effect.runPromise(asBoot(app, await remote(other)).pipe(Effect.result))).toMatchObject({
				_tag: "Failure",
				failure: { code: "store_engine_mismatch" },
			});
		}
	}
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
		[undefined, undefined, "APP_STORE or APP_DATABASE"],
		[undefined, "relative.db", "APP_DATABASE"],
		["file:/a/../b", "/b", "APP_STORE"],
	] as const) {
		const result = await Effect.runPromise(childStore(raw, legacy).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "store_descriptor_invalid", variable } });
		if (result._tag === "Failure") expect(result.failure.message).toBe(`${variable}: store_descriptor_invalid`);
	}
});
