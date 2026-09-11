# Local observability

Boot creates an Effect root span and writes one bounded `http.request` event at HTTP scope completion. Its duration includes streaming and interruption. Public trace headers and baggage cannot select that root. The authenticated child receives a private parent trace header; its `http.app` span covers handler execution until response construction.

`ctx.log.set({topic, message_id, lock_state})` accumulates selected fields on that handler span; the extension filename is added automatically. Values accept only bounded identifier characters. The app currently emits a legacy private response header for these fields; boot strips it without parsing or aggregation. App/tooling owns any export of handler annotations. Later streaming-body annotations cannot be returned after headers commit. Boot's bounded request record contains its own duration and outcome only, without child topic/message/extension fields.

Effect Logger diagnostics in the installed application and serving boot runtime enter scoped dropping queues, then the event log. Queue capacity is 256; overflow and failed writes are dropped without retries. The drain has logging disabled to prevent recursion. This is best-effort diagnostics, not transaction evidence. The app drain serializes with lifecycle changes and never publishes while rehearsal/frozen. Startup before the event graph exists still uses the runtime's default logger.

Only bounded string messages are exported; structured objects and causes are omitted, with a failure flag instead. Common credential assignments, bearer values, and 64-digit hex values are redacted. NDJSON stderr contains the same sanitized fields, excluding fiber annotations. Arbitrary secrets embedded in prose cannot be identified reliably: do not log credentials. No telemetry is exported off-machine by default. The optional tooling drain is documented in `pages/tooling/README.md`.

Boot has no Prometheus metrics registry or scrape endpoint. Metrics presentation belongs to editable app tooling; current recovery traffic state remains available through authenticated `/_boot/status`.
