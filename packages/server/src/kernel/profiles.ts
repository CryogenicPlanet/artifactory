import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";

export const Profile = Schema.Struct({
	emoji: Schema.NullOr(Schema.String),
	color: Schema.NullOr(Schema.String),
	status: Schema.String,
});
export const ProfilePatch = Schema.Struct({
	emoji: Schema.optionalKey(Schema.NullOr(Schema.String)),
	color: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.String),
});
export const Instance = Schema.Struct({
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.String,
	created_at: Schema.Int,
	last_seen_at: Schema.NullOr(Schema.Int),
});
export const AgentList = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			agent: Schema.String,
			kind: Schema.String,
			profile: Profile,
			created_at: Schema.Int,
			last_seen_at: Schema.NullOr(Schema.Int),
			instances: Schema.Array(Instance),
		}),
	),
});
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const get = (agent: string) =>
		sql`SELECT emoji,color,status FROM agents WHERE name=${agent}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Profile))),
			Effect.map((rows) => rows[0] ?? { emoji: null, color: null, status: "" }),
		);
	return {
		get,
		update: (agent: string, patch: typeof ProfilePatch.Type) =>
			Effect.gen(function* () {
				if (
					Object.keys(patch).length === 0 ||
					(patch.status !== undefined && patch.status.length > 1024) ||
					(patch.emoji != null &&
						(patch.emoji.length === 0 || patch.emoji.length > 64 || /[\s\p{Cc}]/u.test(patch.emoji))) ||
					(patch.color != null && !/^#[\da-f]{6}$/i.test(patch.color))
				)
					return yield* new KernelError({ code: "input_invalid" });
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* writerGate(sql, boot.epoch);
						const profile = { ...(yield* get(agent)), ...patch };
						yield* sql`INSERT INTO agents(name,emoji,color,status) VALUES(${agent},${profile.emoji},${profile.color},${profile.status}) ON CONFLICT(name) DO UPDATE SET emoji=excluded.emoji,color=excluded.color,status=excluded.status`;
						return profile;
					}),
				);
			}),
		list: Effect.gen(function* () {
			const roster = yield* boot.agents;
			const profiles = yield* sql`SELECT name,emoji,color,status FROM agents`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String, ...Profile.fields }))),
				),
			);
			const names = [...new Set(roster.items.map((item) => item.agent))].sort();
			return {
				items: names.map((agent) => {
					const instances = roster.items
						.filter((item) => item.agent === agent)
						.map((item) => ({
							instance: item.instance,
							label: item.label,
							kind: item.kind,
							created_at: item.created_at,
							last_seen_at: item.last_seen_at,
						}));
					const profile = profiles.find((row) => row.name === agent);
					const lastSeen = instances.flatMap((item) => (item.last_seen_at === null ? [] : [item.last_seen_at]));
					return {
						agent,
						kind: instances[0]?.kind ?? "agent",
						profile: { emoji: profile?.emoji ?? null, color: profile?.color ?? null, status: profile?.status ?? "" },
						created_at: Math.min(...instances.map((item) => item.created_at)),
						last_seen_at: lastSeen.length ? Math.max(...lastSeen) : null,
						instances,
					};
				}),
			};
		}),
	};
});
/** Stores editable agent presentation; verified identities and presence remain boot-owned.
 * Profile writes use the same epoch fence and HTTP drain admission as other app writes. */
export class Profiles extends Context.Service<Profiles, Effect.Success<typeof make>>()("comms/server/Profiles") {}
export const layer = Layer.effect(Profiles, make);
