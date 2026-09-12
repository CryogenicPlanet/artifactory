import { DateTime, Effect, Schema, Stream } from "effect";
import type { Api, EventContext } from "../../packages/server/src/kernel/extension-api.ts";

const Profile = Schema.Struct({
	emoji: Schema.NullOr(Schema.String),
	color: Schema.NullOr(Schema.String),
	status: Schema.String,
});
const Patch = Schema.Struct({
	emoji: Schema.optionalKey(Schema.NullOr(Schema.String)),
	color: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.String),
});
const Outcome = Schema.Struct({ agent: Schema.String, ...Profile.fields, seq: Schema.Int });
const invalid = () =>
	Response.json(
		{
			error: {
				code: "profile_invalid",
				message: "Invalid profile update.",
				hint: "Send only emoji (at most 32 characters), color (#RRGGBB), or status (at most 280 characters). No query parameters; JSON is limited to 4 KiB and five seconds.",
				retriable: false,
			},
		},
		{ status: 400 },
	);

/** Replayed app activity never moves an instance backwards; payloads and credentials are not copied. */
export const observeActivity = (ctx: Pick<EventContext, "event" | "db" | "mutate">) => {
	const event = ctx.event;
	if ((event.type !== "message.created" && event.type !== "profile.updated") || event.instance === null) return;
	return ctx.mutate(
		Effect.gen(function* () {
			const current = yield* ctx.db`SELECT source_seq FROM example_roster WHERE instance=${event.instance}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ source_seq: Schema.Int })))),
			);
			if ((current[0]?.source_seq ?? -1) >= event.seq) return;
			if (current.length)
				yield* ctx.db`UPDATE example_roster SET agent=${event.actor},last_observed_at=${event.at},source_seq=${event.seq} WHERE instance=${event.instance}`;
			else
				yield* ctx.db`INSERT INTO example_roster(instance,agent,last_observed_at,source_seq) VALUES(${event.instance},${event.actor},${event.at},${event.seq})`;
		}),
	);
};

/** Optional board decoration. Observed app activity is a roster, not credential inventory or online presence. */
export default function roster(api: Api) {
	return Effect.gen(function* () {
		yield* api.migrate(
			"profiles",
			"CREATE TABLE example_profiles(agent TEXT PRIMARY KEY,value TEXT NOT NULL,previous TEXT,updated_seq INTEGER NOT NULL)",
		);
		yield* api.migrate(
			"instances",
			"CREATE TABLE example_roster(instance TEXT PRIMARY KEY,agent TEXT NOT NULL,last_observed_at INTEGER NOT NULL,source_seq INTEGER NOT NULL)",
		);
		for (const type of ["message.created", "profile.updated"] as const)
			api.on(type, (_payload: Schema.Json, ctx: EventContext) => observeActivity(ctx));
		api.route("PATCH", "/api/me", {
			description:
				"Update your agent profile decoration (emoji, color, status). Optional roster extension; requires write. Optional Idempotency-Key.",
			scope: "write",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (Object.keys(ctx.query).length) return invalid();
					let bytes = 0;
					const decoded = yield* request.stream.pipe(
						Stream.tap((chunk) =>
							Effect.try(() => {
								bytes += chunk.byteLength;
								if (bytes > 4096) throw new Error("Profile request too large");
							}),
						),
						Stream.runCollect,
						Effect.flatMap((chunks) =>
							Schema.decodeEffect(Schema.fromJsonString(Patch), { onExcessProperty: "error" })(
								Buffer.concat(chunks).toString("utf8"),
							),
						),
						Effect.timeout("5 seconds"),
						Effect.result,
					);
					if (decoded._tag === "Failure") return invalid();
					const patch = decoded.success;
					if (
						!Object.keys(patch).length ||
						(patch.emoji?.length ?? 0) > 32 ||
						(patch.status?.length ?? 0) > 280 ||
						(patch.color != null && !/^#[0-9a-fA-F]{6}$/.test(patch.color))
					)
						return invalid();
					const key = request.headers["idempotency-key"];
					if (key !== undefined && (key.length < 1 || key.length > 200)) return invalid();
					const input = yield* Schema.encodeEffect(Schema.fromJsonString(Patch))(patch);
					const outcome = yield* ctx.mutate({
						...(key === undefined
							? {}
							: {
									idempotency: {
										instance: ctx.instance,
										key,
										kind: "profile.updated",
										input,
										outcome: Schema.fromJsonString(Outcome),
									},
								}),
						body: (reserve) =>
							Effect.gen(function* () {
								const rows = yield* ctx.db`SELECT value FROM example_profiles WHERE agent=${ctx.agent}`.pipe(
									Effect.flatMap(
										Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.fromJsonString(Profile) }))),
									),
								);
								const previous = rows[0]?.value;
								const next = { ...(previous ?? { emoji: null, color: null, status: "" }), ...patch };
								const value = yield* Schema.encodeEffect(Schema.fromJsonString(Profile))(next);
								const range = yield* reserve(1);
								if (previous)
									yield* ctx.db`UPDATE example_profiles SET previous=value,value=${value},updated_seq=${range.to} WHERE agent=${ctx.agent}`;
								else
									yield* ctx.db`INSERT INTO example_profiles(agent,value,previous,updated_seq) VALUES(${ctx.agent},${value},NULL,${range.to})`;
								const outcome = { agent: ctx.agent, ...next, seq: range.to };
								return {
									outcome,
									events: [
										{
											seq: range.to,
											at: (yield* DateTime.nowAsDate).getTime(),
											type: "profile.updated",
											level: "info" as const,
											actor: ctx.agent,
											instance: ctx.instance,
											generation: ctx.generation,
											request_id: ctx.request,
											topic: null,
											message_id: null,
											payload: outcome,
										},
									],
								};
							}),
					});
					return Response.json(outcome, { headers: { "cache-control": "no-store" } });
				}),
		});
		api.route("GET", "/api/agents", {
			description:
				"List identities observed creating messages or updating profiles, with optional profile decoration. last_observed_at is incomplete app activity; reads are not observed. Retained older rows may reflect historical request activity. Not online presence or token validity. Requires read.",
			scope: "read",
			handler: (_request, ctx) =>
				Effect.gen(function* () {
					if (Object.keys(ctx.query).length) return invalid();
					const items = yield* ctx.read((fence) =>
						ctx.db`WITH profiles AS (SELECT agent,CASE WHEN updated_seq<=${fence} THEN value ELSE previous END AS value FROM example_profiles) SELECT roster.agent,roster.instance,roster.last_observed_at,profiles.value AS profile FROM example_roster roster LEFT JOIN profiles ON profiles.agent=roster.agent WHERE roster.source_seq<=${fence} ORDER BY roster.agent,roster.instance`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Array(
										Schema.Struct({
											agent: Schema.String,
											instance: Schema.String,
											last_observed_at: Schema.Int,
											profile: Schema.NullOr(Schema.fromJsonString(Profile)),
										}),
									),
								),
							),
						),
					);
					return Response.json({ items }, { headers: { "cache-control": "no-store" } });
				}),
		});
	});
}
