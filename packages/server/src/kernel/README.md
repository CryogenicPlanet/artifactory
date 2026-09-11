# kernel

Effect services for the app store, published message/topic reads and writes, profiles, extension lifecycles, and the guarded boot channel. Start with `database.ts`, `messages.ts`, and `ext.ts`; `server.ts` wires their layers. Boot owns authentication, sequence allocation, and the durable event log.

All app writes check the current writer epoch. Mutation events publish through the transactional outbox before their HTTP success; readers select the published image. Runtime state belongs to each service instance or scope.
