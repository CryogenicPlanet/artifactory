// Test observer only. Caller has already stopped every owner of this disposable source.
// Preserve WAL bytes; rebuild only transient shared memory in a private writable directory.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const inspectSqliteSnapshot = <A>(filename: string, inspect: (database: Database) => A): A => {
	const directory = mkdtempSync(join(tmpdir(), "comms-transfer-observer-"));
	try {
		const snapshot = join(directory, "snapshot.db");
		copyFileSync(filename, snapshot);
		if (existsSync(`${filename}-wal`)) copyFileSync(`${filename}-wal`, `${snapshot}-wal`);
		const database = new Database(snapshot, { readonly: true });
		try {
			return inspect(database);
		} finally {
			database.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};
