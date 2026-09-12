// Independent native SQLite inspection for real-Bun integration tests.
import { Database } from "bun:sqlite";
function inspectStore() {
	const [filename, statement] = process.argv.slice(2);
	if (!filename || !statement) throw new Error("Expected database filename and SQL");
	const db = new Database(filename);
	try {
		// Independent fixture writes can overlap a live child's brief SQLite transaction.
		db.exec("PRAGMA busy_timeout = 5000");
		process.stdout.write(JSON.stringify(db.query(statement).all()));
	} finally {
		db.close();
	}
}

inspectStore();
