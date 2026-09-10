import app from "./server";
const a = app();
Bun.serve({ port: Number(process.env.PORT), fetch: (req) => new URL(req.url).pathname === "/health" ? new Response("ok") : a.fetch(req) });
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
