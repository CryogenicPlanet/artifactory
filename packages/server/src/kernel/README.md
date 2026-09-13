# Application kernel

The kernel gives editable code a shared write and recovery boundary. It owns writer-epoch checks, mutation receipts, transactional outbox publication, publication-aware reads and extension lifecycles. Boot owns authentication, sequence allocation and the durable event log.

Start with:

- [publication.ts](publication.ts): shared mutation/read coordination and outbox relay.
- [mutate.ts](mutate.ts): the durable mutation protocol.
- [ext.ts](ext.ts): extension loading and scoped lifecycle.
- [extension-api.ts](extension-api.ts): the extension authoring API.
- [health.ts](health.ts): a reserved-route dispatch and kernel KV mutation/read probe with verified rollback.

[server.ts](../server.ts) wires one shared Publication instance. Product routes and domain SQL live in [ext/core](../ext/core/); the kernel consumes their [capability contract](extension-capabilities.ts), without constructing domain services.

Preserve the writer epoch, atomic mutation evidence and publication boundary when changing this code. Readiness dispatches `/_kernel/readiness` through the same extension dispatcher and application router used by requests, then verifies the kernel KV protocol and rollback. Product routes remain replaceable. Own runtime state in a service instance or scope, and keep network work outside SQL read snapshots.
