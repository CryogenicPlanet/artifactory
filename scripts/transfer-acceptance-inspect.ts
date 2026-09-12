// Read-only observer for the disposable SQLite check target, outside the application runtime.
import { inspectSqliteSnapshot } from "./transfer-acceptance-sqlite-snapshot.ts";
import { Schema } from "effect";

const [boot, app] = process.argv.slice(2);
const selected = boot?.match(/^\/data\/transfers\/([a-f0-9-]{36})\/scratch\/boot\.db$/);
if (!boot || !selected || app !== `/data/rehearsals/transfer-check-${selected[1]}/comms.db`)
	throw new Error("Invalid disposable check paths");
const inspect = (filename: string, tables: readonly string[], marker: boolean) => {
	inspectSqliteSnapshot(filename, (database) => {
		for (const table of tables) {
			const row = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
				database.query(`SELECT COUNT(*) AS count FROM "${table}"`).get(),
			);
			if (row.count !== 0) throw new Error("Check copied source business rows");
		}
		if (marker) {
			const row = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(
				database.query("SELECT value FROM settings WHERE key='transfer_state'").get(),
			);
			if (row.value !== "in_progress") throw new Error("Check target became eligible for startup");
		}
	});
};
inspect(app, ["messages"], false);
inspect(boot, ["passkeys", "generations"], true);
console.log("SQLite check retained an ineligible empty target");
