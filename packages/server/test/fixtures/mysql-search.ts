import { mysqlIndexedParts, mysqlSearchConfig } from "../../src/ext/core/mysql-search-config.ts";
import { BunServices } from "@effect/platform-bun";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { searchMessages } from "../../src/ext/core/search.ts";
import { testStore } from "./test-store.ts";

async function main() {
	let phase = "connect";
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* testStore({
					engine: "mysql",
					config: process.env.COMMS_MYSQL_SEARCH_CONFIG,
					database: "comms_search_mysql",
					tables: ["messages", "custom_stopwords"],
				});
				phase = "index setup";
				yield* sql`CREATE TABLE messages(id VARCHAR(64) PRIMARY KEY,body LONGTEXT NOT NULL,previous_body LONGTEXT,updated_seq BIGINT NOT NULL,FULLTEXT(body),FULLTEXT(previous_body)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
				yield* sql`INSERT INTO messages VALUES
				('both','alpha beta',NULL,1),
				('alpha','alpha gamma',NULL,1),
				('beta','beta gamma',NULL,1),
				('exact','the deploy',NULL,1),
				('superset','deploy service',NULL,1),
				('stopword','the service',NULL,1),
				('old','gamma','alpha beta',20),
				('future','alpha beta','gamma',20)`;
				const config = yield* mysqlSearchConfig(sql);
				assert(config);
				phase = "native stopword collation";
				assert.deepEqual(
					yield* mysqlIndexedParts(sql, ["the", "THE"], {
						...config,
						stopwords: ["THE"],
						characterSet: "utf8mb4",
						collation: "utf8mb4_0900_as_cs",
					}),
					["the"],
				);
				assert.deepEqual(
					yield* mysqlIndexedParts(sql, ["the", "THE"], {
						...config,
						stopwords: ["THE"],
						characterSet: "utf8mb4",
						collation: "utf8mb4_0900_ai_ci",
					}),
					[],
				);
				const find = (query: string) =>
					Effect.gen(function* () {
						const predicate = yield* searchMessages(sql, query, 10, false, config);
						return yield* sql`SELECT id FROM messages WHERE ${predicate} ORDER BY id`;
					});
				phase = "AND excludes single-term distractors and unpublished images";
				assert.deepEqual(yield* find("alpha beta"), [{ id: "both" }, { id: "old" }]);
				phase = "indexed term baseline";
				assert.deepEqual(yield* find("deploy"), [{ id: "exact" }, { id: "superset" }]);
				phase = "stopword query preserves the documented superset";
				assert.deepEqual(yield* find("the deploy"), [{ id: "exact" }, { id: "superset" }]);
				assert.deepEqual(yield* find("ok deploy"), [{ id: "exact" }, { id: "superset" }]);
				assert.equal((yield* find("the ok")).length, 8);
				// Settings are session-only and indexes are rebuilt in this exclusively allocated scratch store.
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`CREATE TABLE custom_stopwords(value VARCHAR(64)) ENGINE=InnoDB`;
						yield* sql`INSERT INTO custom_stopwords VALUES('alpha')`;
						for (const custom of [true, false]) {
							phase = custom ? "custom stopword index" : "disabled stopword index";
							phase = `drop index ${custom}`;
							yield* sql`DROP TABLE messages`;
							phase = `select custom list ${custom}`;
							yield* sql`SET SESSION innodb_ft_user_stopword_table='comms_search_mysql/custom_stopwords'`;
							phase = `enable stopword ${custom}`;
							yield* custom
								? sql`SET SESSION innodb_ft_enable_stopword=ON`
								: sql`SET SESSION innodb_ft_enable_stopword=OFF`;
							yield* sql`CREATE TABLE messages(id VARCHAR(64) PRIMARY KEY,body LONGTEXT NOT NULL,previous_body LONGTEXT,updated_seq BIGINT NOT NULL,FULLTEXT(body),FULLTEXT(previous_body)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
							yield* sql`INSERT INTO messages VALUES('both','alpha beta',NULL,1),('beta','beta gamma',NULL,1)`;
							phase = `read config ${custom}`;
							const configured = yield* mysqlSearchConfig(sql);
							assert(configured);
							assert.deepEqual(configured.stopwords, custom ? ["alpha"] : []);
							phase = `custom query ${custom}`;
							const predicate = yield* searchMessages(sql, "alpha beta", 10, false, configured);
							assert.deepEqual(
								yield* sql`SELECT id FROM messages WHERE ${predicate} ORDER BY id`,
								custom ? [{ id: "beta" }, { id: "both" }] : [{ id: "both" }],
							);
						}
					}),
				);
			}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(Reactivity.layer)),
		);
		process.stdout.write("MYSQL_SEARCH_VERIFIED\n");
	} catch {
		throw new Error(`MySQL search fixture failed during ${phase}`);
	}
}
await main();
