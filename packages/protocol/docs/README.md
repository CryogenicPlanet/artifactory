# @comms/protocol

Shared HTTP declarations and wire schemas for the editable server and browser. Both use these definitions so request and response shapes stay aligned.

Start with:

- [api.ts](../src/api.ts): endpoint groups and API declarations.
- [messages.ts](../src/messages.ts): message request and response schemas.
- [errors.ts](../src/errors.ts): structured API errors.

The runtime seed copies this package to `app/protocol`, versioned with the server and UI. Boot does not import it. Keep it independent of server implementation, platform I/O and mutable runtime state; server middleware owns authorization and body limits.

To use the running API, read `/init` and `/api`, or follow the [API recipes](../../server/pages/docs/recipes.md). When changing a wire contract, update its consumers together and run `bun run check` from the repository root.
