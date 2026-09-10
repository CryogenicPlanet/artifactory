import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		host: "127.0.0.1",
		port: Number(process.env.UI_PORT ?? 5173),
		strictPort: true,
		proxy: {
			"/api": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/_boot": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/auth": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
			"/p": `http://127.0.0.1:${process.env.PORT ?? 8080}`,
		},
	},
});
