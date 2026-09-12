import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function run() {
	const directory = process.env.DESCENDANT_DIRECTORY;
	if (!directory) throw new Error("Missing disposable descendant directory");
	if (process.env.DESCENDANT_ROLE === "writer") {
		const db = new Database(join(directory, "writes.db"));
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("CREATE TABLE writes(n INTEGER NOT NULL)");
		db.exec("INSERT INTO writes VALUES(0)");
		const write = db.query("UPDATE writes SET n=n+1");
		process.on("SIGTERM", () => {});
		write.run();
		writeFileSync(join(directory, "writer-ready"), String(process.pid));
		if (process.env.DESCENDANT_MODE === "hung") while (true) write.run();
		setInterval(() => write.run(), 20);
		return;
	}
	const writer = spawn(process.execPath, [import.meta.filename], {
		env: { ...process.env, DESCENDANT_ROLE: "writer" },
		stdio: "ignore",
	});
	process.on("SIGTERM", () => {});
	const ready = setInterval(() => {
		if (!existsSync(join(directory, "writer-ready"))) return;
		clearInterval(ready);
		writeFileSync(join(directory, "pids"), JSON.stringify([process.pid, writer.pid]));
		console.log("DESCENDANT_READY");
		if (process.env.DESCENDANT_MODE === "hung") while (true) {}
		setInterval(() => {
			if (existsSync(join(directory, "exit-leader"))) process.exit(0);
		}, 20);
	}, 10);
}
run();
