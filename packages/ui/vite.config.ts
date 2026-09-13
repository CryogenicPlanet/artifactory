import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "first-visit-onboarding",
			configureServer(server) {
				server.middlewares.use(async (request, response, next) => {
					if (
						request.method !== "GET" ||
						request.url?.split("?")[0] !== "/" ||
						!request.headers.accept?.includes("text/html")
					)
						return next();
					try {
						const state = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/auth/login`, {
							redirect: "manual",
							signal: AbortSignal.timeout(2000),
						});
						if (state.status === 302 && state.headers.get("location") === "/onboarding") {
							response.writeHead(302, { location: "/onboarding", "cache-control": "no-store" });
							response.end();
							return;
						}
					} catch {
						/* Vite remains available while the local boot process starts. */
					}
					next();
				});
			},
		},
	],
	server: {
		host: "localhost",
		port: Number(process.env.UI_PORT ?? 5173),
		strictPort: true,
		proxy: {
			"/init": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/.well-known/agent.json": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/api": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/_boot": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/onboarding": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/setup": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/auth": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/approve": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/p": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
		},
	},
});
