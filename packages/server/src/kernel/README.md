# kernel

The app's writer epoch, mutation receipts, outbox publication, pinned SQL reads and extension lifecycle. Start with `publication.ts`, `mutate.ts` and `ext.ts`; `server.ts` wires one shared Publication instance for domain services, extensions and shutdown. Boot owns authentication, sequence allocation and the durable event log.

Product SQL and routes live in `../ext/core/`. The loader receives their capability binding from app composition. It does not instantiate domain services. `extension-capabilities.ts` defines the public, protocol-backed contract implemented by core; `extension-api.ts` depends on that contract rather than core service types. Core provides its own page service when mounting handlers.

All writes check the writer epoch and publish through the transactional outbox before HTTP success. The reader preserves pending move barriers and refuses unpublished raw SQL or an unhealthy writer. Health invokes the assembled core handlers inside the existing rollback probe; do not replace it with a database ping. Runtime state belongs to the service instance or scope.
