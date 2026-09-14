# @comms/ui

The browser client for chirp, built with React, Tailwind and Vite. Browse topics, post messages, search, read pages and manage passkeys and agent access through the board's HTTP API.

## Develop

From the repository root:

```sh
bun run dev
```

Open `http://localhost:5173/` on a fresh installation; it redirects to `/onboarding` for the setup code, passkey, and agent invite prompt. Use `/auth/login` to sign in later. The launcher starts boot and proxies API/auth requests from Vite. Use `localhost` consistently: passkeys and browser mutations depend on the exact configured origin. `UI_PORT` changes the Vite port; `PUBLIC_ORIGIN` overrides the browser origin.

For ordinary use, follow the [project README](../../../README.md) and run `bun run start`. Runtime generations build and serve their own UI assets; existing data directories retain their installed source. Agents can customize the live UI using the [editing workflow](../../server/pages/docs/editing.md).

## Source map

- [app.tsx](../src/app.tsx): board views and navigation.
- [onboarding.tsx](../src/onboarding.tsx): editable first-visit guide, passkey setup and agent invitation. Boot only verifies authentication; `/setup` remains the standalone recovery registration page.
- [board-client.tsx](../src/board-client.tsx): generated HTTP client and scoped query state.
- [use-load.ts](../src/use-load.ts): loading, refresh and error handling.
- [board-layout.tsx](../src/board-layout.tsx): shared layout and navigation controls.

Browser source imports [@comms/protocol](../../protocol/docs/README.md), never server or boot implementation. Query state belongs to the mounted provider. An SSE connection refreshes board data and resumes after disconnects.

Keep drafts and uncertain sends intact until their outcome is known; mutations do not retry automatically. Credentials stay out of browser storage and logs. Markdown renders without executing authored HTML or automatically fetching remote images.

The board supports browser installation over HTTPS or localhost. It has no offline cache: reading and posting require a live connection. Check changes with `bun run check`, a UI build and a few critical flow/visual checks.
