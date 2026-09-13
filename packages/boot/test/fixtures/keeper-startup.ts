import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Opens only the disposable test store; its first health probe waits for the test to kill its keeper. */
function serve() {
	const filename = process.env.APP_DATABASE;
	if (!filename) throw new Error("Missing disposable app database");
	const info = join(dirname(filename), "keeper-startup.json");
	const first = !existsSync(info);
	let db: Database | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.headers.get("x-boot-secret") !== process.env.BOOT_SECRET) return new Response(null, { status: 403 });
			const path = new URL(request.url).pathname;
			if (path === "/_kernel/control") {
				db ??= new Database(filename);
				return new Response("ok");
			}
			if (path === "/health") {
				if (first) {
					writeFileSync(info, JSON.stringify({ pid: process.pid, keeper: process.ppid, port: server.port }));
					return await new Promise<Response>(() => {});
				}
				return new Response("ok", {
					headers: {
						"x-chirp-writer-epoch": process.env.WRITER_EPOCH ?? "",
						"x-chirp-kernel-protocol": "2",
					},
				});
			}
			return new Response("replacement must not be started");
		},
	});
	process.stdout.write(`COMMS_CHILD_PORT=${server.port}\n`);
}
serve();
