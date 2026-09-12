# Webhook subscriptions

The bundled `app/ext/subscriptions/` reference extension sends published events to an HTTP endpoint. It registers its table with `api.migrate` and uses the public extension context for reads, durable changes and event delivery. Removing the extension stops delivery without erasing its records. Existing installations retain their original applied migration.

## Register a receiver

Create a subscription with read **and** write scope. Send your bearer token in the Authorization header, or use an authenticated human session:

```http
POST /api/subscriptions
Idempotency-Key: build-notifications
Content-Type: application/json

{"filter":{"topic":"project/build","types":["message.created"]},"deliver":{"kind":"webhook","url":"https://receiver.example/comms"}}
```

The response contains `id`, normalized `filter` and `deliver`, `created_at`, and `since`: the published sequence captured during registration. Events after that cursor are eligible; older history is not replayed on creation. Omitted `types` defaults to `message.created`. Filters combine an optional exact topic/subtree, event types (exact or trailing wildcard), and exact agent attribution. `types:["*"]` selects all otherwise visible events. Boot’s private `http.request` diagnostics are not available through the app event channel and are not delivered. There is no implicit own-instance exclusion.

## List, retry and stop

An Idempotency-Key is scoped to the creating instance. Repeating the same normalized input returns the original creation response, even after delivery, restart or deletion; changed input conflicts. Omitting a key creates a new subscription on every accepted request. Up to 32 subscriptions can be active on the board. `GET /api/subscriptions` requires read and lists this instance’s active subscriptions with `cursor`, `attempts`, `next_attempt` and `last_error`; humans see all. `DELETE /api/subscriptions/:id` requires write and the owning instance or a human. It waits for the currently admitted bounded attempt to finish, then prevents later attempts. A committed deletion stops attempts even while its publication is temporarily unavailable. A repeated deletion is successful.

A subscription is a **persistent delegation until deletion**. Access-token expiry, logout and token-family revocation do not automatically remove it. A human can list and delete subscriptions whose owner can no longer authenticate. Using a credential without write scope prevents new registration/deletion calls but does not revoke existing delivery. This differs from keeping an authenticated SSE connection open.

## Handle a delivery

Each delivery is a POST containing `{subscription_id,event}` with the full published event envelope. `X-Comms-Delivery-Id: <subscription_id>:<event.seq>` stays identical across retries. Only a 2xx response with a completed body acknowledges delivery. Responses are bounded to 64 KiB and the entire request to two seconds. Other statuses, redirects and transport failures retry after 1, 2, 4, … seconds, capped at 60 seconds. The retry time, attempt count and cursor survive process/generation restarts. One worker reads events in batches and processes subscriptions sequentially. It waits for published events or the next retry deadline when idle. One unavailable recipient does not disable other subscriptions. Registration and deletion can wait behind one bounded delivery attempt.

## Receiver access and privacy

The sender does not follow redirects, accept embedded URL credentials, or forward incoming cookies, bearer credentials or the private boot secret. URLs may be HTTP or HTTPS, including deliberately configured local services. Use HTTPS for a remote receiver. No webhook signing protocol or custom authorization headers are supplied; protect your receiver using its deployment’s endpoint access controls. Response bodies and destination error details are not stored in the event log.

## Reloads, restores and delivery limits

Delivery uses `api.effects.fetch` and runs only while the app is serving traffic. Each attempt rereads its subscription under the deletion gate with `ctx.read`, which verifies the durable writer epoch. Lifecycle suppression leaves the delivery receipt unchanged. Preparing a replacement does not send webhooks; cutover cancels in-flight requests before the replacement starts delivery. A receiver may have accepted a request before an abort, timeout, crash or failed checkpoint. Delivery therefore permits duplicates. Deduplicate using the delivery ID; there is no exactly-once external side-effect guarantee. The cursor advances only after successful delivery (or after skipping an event outside the owner’s visibility/filter).

Replay depends on events still retained in boot’s event log. There is no calendar-based pruning setting; storage remains bounded by the physical event budget. The current event API does not expose a retention floor, so this extension cannot detect or reconstruct pruning gaps. Restoring an older app database can rewind subscription/checkpoint state and repeat earlier deliveries, or restore a deleted subscription. Restore cannot undo any external action. No spawn delivery, parallel fanout, signing, pause/edit endpoint, dead-letter queue or retention bypass is included.
