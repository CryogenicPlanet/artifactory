import { rehearsalReportHeader } from "@comms/protocol/headers";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { readRehearsalReport } from "../src/rehearsal-report.ts";

const decode = (value: unknown, version = "1") =>
	Effect.runPromise(
		readRehearsalReport(
			HttpServerResponse.toClientResponse(
				HttpServerResponse.jsonUnsafe(value, { headers: { [rehearsalReportHeader]: version } }),
			),
		),
	);
it("distinguishes historical unavailable reporting from a validated empty report", async () => {
	expect(await decode({ status: "ok" }, "")).toEqual({ report_unavailable: true });
	expect(await decode({ status: "ok", suppressed: [], suppressed_overflow: 0 })).toEqual({
		suppressed: [],
		suppressed_overflow: 0,
	});
});
it("rejects malformed, oversized and excessive advertised reports", async () => {
	await expect(decode({ status: "ok" })).rejects.toThrow();
	await expect(decode({ suppressed: [], suppressed_overflow: 0 }, "2")).rejects.toThrow();
	await expect(decode({ suppressed: [], suppressed_overflow: -1 })).rejects.toThrow();
	const entry = { extension: "example.ts", kind: "notify", reason: "rehearsal", destination: "https://example.com" };
	await expect(
		decode({ suppressed: Array.from({ length: 65 }, () => entry), suppressed_overflow: 0 }),
	).rejects.toThrow();
	await expect(
		decode({ suppressed: [{ ...entry, destination: "x".repeat(257) }], suppressed_overflow: 0 }),
	).rejects.toThrow();
	await expect(decode({ suppressed: [], suppressed_overflow: 0, padding: "x".repeat(65536) })).rejects.toThrow();
});

it("preserves bounded migration warnings without allowing SQL or arbitrary diagnostic fields", async () => {
	const warning = { code: "migration.non_portable", migration: "2_example", extension: "example.ts" };
	const report = { suppressed: [], suppressed_overflow: 0, warnings: { items: [warning], overflow: 0 } };
	expect(await decode(report)).toEqual(report);
	expect(await decode({ ...report, warnings: { items: [{ ...warning, sql: "private SQL" }], overflow: 0 } })).toEqual(
		report,
	);
	for (const warnings of [
		{ items: Array.from({ length: 65 }, () => warning), overflow: 0 },
		{ items: [{ ...warning, migration: "x".repeat(129) }], overflow: 0 },
		{ items: [{ ...warning, code: "other" }], overflow: 0 },
		{ items: [warning], overflow: -1 },
	])
		await expect(decode({ ...report, warnings })).rejects.toThrow();
});
