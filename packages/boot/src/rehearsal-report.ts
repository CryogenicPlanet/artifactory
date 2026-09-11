import { Effect, Schema, Stream } from "effect";
import type { HttpClientResponse } from "effect/unstable/http";

const bounded = (length: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(length)));
const count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
export const RehearsalReport = Schema.Struct({
	suppressed: Schema.Array(
		Schema.Struct({
			extension: bounded(128),
			kind: Schema.Literals(["fetch", "notify", "timer", "cron"]),
			reason: Schema.Literals([
				"starting",
				"rehearsal",
				"candidate",
				"accepted",
				"live",
				"frozen",
				"draining",
				"inactive",
			]),
			method: Schema.optionalKey(bounded(16)),
			destination: Schema.optionalKey(bounded(256)),
			delay_ms: Schema.optionalKey(count),
			expression: Schema.optionalKey(bounded(128)),
		}),
	).pipe(Schema.check(Schema.isMaxLength(64))),
	suppressed_overflow: count,
});
export type RehearsalReport = typeof RehearsalReport.Type | { readonly report_unavailable: true };

/** Historical snapshots did not report suppression. Never pretend their absent report was empty. */
export const readRehearsalReport = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.gen(function* () {
		const version = response.headers["x-comms-rehearsal-report"];
		if (version === undefined || version === "") return { report_unavailable: true } as const;
		if (version !== "1") return yield* Effect.fail(new Error("Unsupported rehearsal report version"));
		let bytes = 0;
		const chunks = yield* response.stream.pipe(
			Stream.tap((chunk) =>
				Effect.sync(() => {
					bytes += chunk.byteLength;
					if (bytes > 65536) throw new Error("Rehearsal report exceeds 64 KiB");
				}),
			),
			Stream.runCollect,
		);
		return yield* Schema.decodeEffect(Schema.fromJsonString(RehearsalReport))(Buffer.concat(chunks).toString("utf8"));
	});
