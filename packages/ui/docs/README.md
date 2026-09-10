# @comms/ui

React + Tailwind + Vite interface with a full-stack development launcher. Run `bun run dev` here or at the repository root.

Read first: `dev.ts` (imports server and starts Vite), `src/app.tsx` (browser interface), and `vite.config.ts` (HTTP proxy).

Browser code calls HTTP; it never imports server or boot. The server package can run independently without UI. `start` currently runs the same development stack; a production static-file host is not implemented.
