import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Missing fixture root");
const database = new Database(join(root, "boot.db"));
try {
	database.exec(readFileSync(join(import.meta.dirname, "boot-schema-v15.sql"), "utf8"));
} finally {
	database.close();
}
