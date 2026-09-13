import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The delayed probe remains asynchronous so reload controls can retire its owner. */
function serve() {
	const filename = process.env.APP_DATABASE;
	if (!filename) throw new Error("Missing disposable database");
	let delayed = false;
	const headers = {
		"x-chirp-writer-epoch": process.env.WRITER_EPOCH ?? "",
		"x-chirp-kernel-protocol": "2",
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (request.headers.get("x-boot-secret") !== process.env.BOOT_SECRET) return new Response(null, { status: 403 });
			const path = new URL(request.url).pathname;
			if (path === "/_kernel/control") return new Response("ok");
			if (path === "/health") return new Response("ok", { headers });
			if (path === "/_kernel/ping") {
				if (delayed) {
					writeFileSync(join(dirname(filename), `ping-${process.pid}`), "waiting");
					await new Promise<void>((resolve) => setTimeout(resolve, 10000));
					return new Response(null, { status: 503 });
				}
				return new Response("ok", { headers });
			}
			if (path === "/delay-ping") delayed = true;
			return Response.json({ pid: process.pid, keeper: process.ppid });
		},
	});
	process.stdout.write(`COMMS_CHILD_PORT=${server.port}\n`);
}
serve();
