// Real Bun child fixture: intentionally independent of the production Effect server.
export function serve(mode: string) {
	if (mode === "exit") throw new Error("fixture startup failed");
	if (mode === "silent") {
		setInterval(() => {}, 1000);
		return;
	}
	const secret = process.env.BOOT_SECRET;
	let received = 0;
	let cancelled = 0;
	if (mode === "stderr") process.stderr.write("x".repeat(100_000) + "stderr-tail\n");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (request.headers.get("x-boot-secret") !== secret) return new Response(null, { status: 403 });
			const url = new URL(request.url);
			if (url.pathname === "/_kernel/control") return new Response("ok");
			if (url.pathname === "/health" || url.pathname === "/_kernel/ping")
				return new Response("ok", {
					status: mode === "unhealthy" ? 500 : 200,
					headers: { "x-comms-writer-epoch": process.env.WRITER_EPOCH ?? "", "x-comms-kernel-protocol": "2" },
				});
			if (url.pathname === "/cancelled") return new Response(String(cancelled));
			if (url.pathname === "/hold-stream")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("open\n"));
						},
						cancel() {
							cancelled++;
						},
					}),
				);
			if (url.pathname === "/disconnect") {
				await server.stop(true);
				return new Response("closed");
			}
			if (url.pathname === "/received") return new Response(String(received));
			if (url.pathname === "/upload") {
				if (request.body) for await (const chunk of request.body) received += chunk.byteLength;
				return new Response(String(received));
			}
			if (url.pathname === "/echo")
				return Response.json({
					method: request.method,
					path: url.pathname,
					search: url.search,
					body: await request.text(),
					authorization: request.headers.get("authorization"),
					cookie: request.headers.get("cookie"),
					assertion: request.headers.get("x-comms-assertion"),
					kind: request.headers.get("x-comms-auth-kind"),
					expires: request.headers.get("x-comms-token-expires"),
					agent: request.headers.get("x-comms-agent"),
					instance: request.headers.get("x-comms-instance"),
					scopes: request.headers.get("x-comms-scopes"),
					label: request.headers.get("x-comms-label"),
					requestId: request.headers.get("x-comms-request-id"),
					forwarded: request.headers.get("x-forwarded-for"),
					hop: request.headers.get("x-hop"),
					contentType: request.headers.get("content-type"),
					inheritedSecret: process.env.BOOT_DATABASE_URL ?? null,
				});
			if (url.pathname === "/stream")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("first\n"));
							setTimeout(() => {
								controller.enqueue(new TextEncoder().encode("second\n"));
								controller.close();
							}, 400);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			if (url.pathname === "/cookies") {
				const headers = new Headers();
				headers.append("set-cookie", "__Host-comms_session=forged; Secure; HttpOnly; Path=/");
				headers.append("set-cookie", "app-preference=dark; Path=/");
				return new Response("cookies", { headers });
			}
			if (url.pathname === "/gzip")
				return new Response(Bun.gzipSync("compressed-body"), { headers: { "content-encoding": "gzip" } });
			if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/echo" } });
			if (url.pathname === "/empty") return new Response(null, { status: 204 });
			if (url.pathname === "/crash") {
				setTimeout(() => process.exit(7), 10);
				return new Response("exiting");
			}
			if (url.pathname === "/crash-inherited") {
				Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 1500)"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "inherit",
				});
				setTimeout(() => process.exit(7), 10);
				return new Response("exiting");
			}
			return new Response("fixture", {
				headers: {
					connection: "x-hop-response, content-type, content-length, set-cookie",
					"x-hop-response": "remove",
					"x-boot-secret": "remove",
					"content-type": "text/custom",
					"set-cookie": "remove=1",
				},
			});
		},
	});
	process.stdout.write(`COMMS_CHILD_PORT=${server.port}\n`);
}
