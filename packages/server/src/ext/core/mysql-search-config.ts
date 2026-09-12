import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { Constructor } from "effect/unstable/sql/Statement";
export class MysqlSearchConfigurationError extends Schema.TaggedError<MysqlSearchConfigurationError>()(
	"MysqlSearchConfigurationError",
	{
		code: Schema.Literal("search_configuration_unavailable"),
	},
) {}

export interface MysqlSearchConfig {
	readonly minimum: number;
	readonly maximum: number;
	readonly stopwords: ReadonlyArray<string>;
	readonly characterSet: string;
	readonly collation: string;
}
const Settings = Schema.Tuple([
	Schema.Struct({
		character_set: Schema.String,
		collation: Schema.String,
		minimum: Schema.Int,
		maximum: Schema.Int,
		enabled: Schema.Literals([0, 1]),
		user_table: Schema.NullOr(Schema.String),
		server_table: Schema.NullOr(Schema.String),
	}),
]);
const Words = Schema.Array(Schema.Struct({ value: Schema.String }));

/** Load per editable service instance; never change the database's full-text configuration. */
export const mysqlSearchConfig = (sql: Constructor) =>
	on<Effect.Effect<MysqlSearchConfig | null, MysqlSearchConfigurationError>>(sql, {
		sqlite: () => Effect.succeed(null),
		pg: () => Effect.succeed(null),
		mysql: () =>
			Effect.gen(function* () {
				const [settings] =
					yield* sql`SELECT @@character_set_server AS character_set,@@collation_server AS collation,@@innodb_ft_min_token_size AS minimum,@@innodb_ft_max_token_size AS maximum,@@SESSION.innodb_ft_enable_stopword AS enabled,@@SESSION.innodb_ft_user_stopword_table AS user_table,@@GLOBAL.innodb_ft_server_stopword_table AS server_table`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Settings)),
					);
				if (
					settings.minimum < 1 ||
					settings.maximum < settings.minimum ||
					!/^[a-zA-Z0-9_]+$/.test(settings.character_set) ||
					!/^[a-zA-Z0-9_]+$/.test(settings.collation)
				)
					return yield* new MysqlSearchConfigurationError({ code: "search_configuration_unavailable" });
				const selected = settings.user_table || settings.server_table;
				let words: ReadonlyArray<{ readonly value: string }> = [];
				if (settings.enabled) {
					if (selected) {
						const parts = selected.split("/");
						const database = parts[0];
						const table = parts[1];
						if (parts.length !== 2 || !database || !table || parts.some((part) => !/^[a-zA-Z0-9_]+$/.test(part)))
							return yield* new MysqlSearchConfigurationError({ code: "search_configuration_unavailable" });
						words = yield* sql`SELECT value FROM ${sql(database)}.${sql(table)} LIMIT 10001`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Words)),
						);
					} else
						words = yield* sql`SELECT value FROM INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Words)),
						);
				}
				if (words.length > 10000)
					return yield* new MysqlSearchConfigurationError({ code: "search_configuration_unavailable" });
				return {
					minimum: settings.minimum,
					maximum: settings.maximum,
					stopwords: words.map(({ value }) => value),
					characterSet: settings.character_set,
					collation: settings.collation,
				} satisfies MysqlSearchConfig;
			}).pipe(Effect.mapError(() => new MysqlSearchConfigurationError({ code: "search_configuration_unavailable" }))),
	});

/** Compare the immutable list with native server collation, inside the caller's read scope. */
export const mysqlIndexedParts = (sql: Constructor, parts: ReadonlyArray<string>, config: MysqlSearchConfig) =>
	Effect.gen(function* () {
		const words = parts.map((part) =>
			(part.match(/[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu) ?? []).filter((word) => {
				const length = [...word].length;
				return length >= config.minimum && length <= config.maximum;
			}),
		);
		const candidates = words.flat();
		if (candidates.length === 0) return [];
		const indexed =
			config.stopwords.length === 0
				? candidates
				: (yield* sql`
		SELECT candidate.value FROM JSON_TABLE(${JSON.stringify(candidates)}, '$[*]' COLUMNS(value VARCHAR(512) PATH '$')) AS candidate
		WHERE NOT EXISTS (SELECT 1 FROM JSON_TABLE(${JSON.stringify(config.stopwords)}, '$[*]' COLUMNS(value VARCHAR(512) PATH '$')) AS stopword
		WHERE CONVERT(candidate.value USING ${sql(config.characterSet)}) COLLATE ${sql(config.collation)} = CONVERT(stopword.value USING ${sql(config.characterSet)}) COLLATE ${sql(config.collation)})
	`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Words)))).map(({ value }) => value);
		return parts.filter((_, index) => words[index]?.some((word) => indexed.includes(word)));
	});
