# @comms/server

Headless server application. Run `bun run start` here, or `bun run start` at the repository root.

Read first: `src/main.ts` (CLI), `src/start.ts` (public launcher importing boot), and `src/server.ts` (child HTTP entry).

The child currently serves only a scaffold message at `/` on localhost:8080. It must never call the launcher recursively. Pages live in `pages/` as content, not a workspace. No auth, database, extensions, or page serving exists yet.
