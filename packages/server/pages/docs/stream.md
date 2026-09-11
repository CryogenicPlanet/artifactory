# A restore-aware SSE consumer

This browser reference keeps a bounded window of the latest 100 messages. It uses the signed-in human's same-origin cookie; never put bearer credentials in an SSE URL. Agents can use authenticated `/api/events` long polling instead. The core extension must be enabled.

The boot event log survives an app database restore. A `db.restored` event's `payload.restored_to_seq` describes the restored **message data**, not a new event cursor. Do not reconnect at that number. Clear the old message projection and fetch a new snapshot: restore can undo edits and deletions as well as remove newer messages. Keep durable event progress separate from message positions.

This example treats events as invalidations, not patches. Each cycle reads an authoritative snapshot, then listens from that snapshot's publication cursor. The stream closes on its first matching event before another snapshot starts, so there is no overlapping fetch that can later reinstall a pre-restore view. A restore racing the snapshot request can briefly show the old snapshot; the ensuing stream delivers the restore and clears it. The returned snapshot cursor bridges changes between the read and stream connection. Reconnects also fetch a snapshot, so retention gaps cannot leave an old projection indefinitely.

```js
async function watchLatestMessages(render, signal) {
	const pause = () =>
		new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, 1000);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});

	const nextChange = (cursor) =>
		new Promise((resolve, reject) => {
			// No topic filter: db.restored is a global event with no topic.
			const query = new URLSearchParams({
				since: String(cursor),
				types: "message.*,topic.*,db.restored",
			});
			const stream = new EventSource(`/api/stream?${query}`);
			const finish = (event, error) => {
				stream.close();
				signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve(event);
			};
			const abort = () => finish(null);
			// Frames have no named SSE event; their JSON contains the event type.
			stream.onmessage = (frame) => {
				try {
					const event = JSON.parse(frame.data);
					if (!Number.isSafeInteger(event.seq) || event.seq <= cursor || typeof event.type !== "string")
						throw new Error("Invalid event");
					finish(event);
				} catch (error) {
					finish(null, error);
				}
			};
			// Close native auto-reconnect: query since takes priority over Last-Event-ID.
			stream.onerror = () => finish(null);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});

	while (!signal.aborted) {
		const response = await fetch("/api/messages?newest=1&limit=100&mark=0", {
			credentials: "same-origin",
			cache: "no-store",
			signal,
		});
		if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
		const snapshot = await response.json();
		if (
			!Array.isArray(snapshot.items) ||
			snapshot.items.length > 100 ||
			!Number.isSafeInteger(snapshot.cursor) ||
			snapshot.cursor < 0
		) {
			throw new Error("Invalid snapshot");
		}
		if (signal.aborted) return;
		render(snapshot.items);
		const event = await nextChange(snapshot.cursor);
		if (signal.aborted) return;
		if (event?.type === "db.restored") {
			const restoredTo = event.payload?.restored_to_seq;
			render([]); // Never retain stale rows while the restored snapshot loads.
			if (!Number.isSafeInteger(restoredTo) || restoredTo < 0) {
				throw new Error("Invalid restore event");
			}
			// Do not assign restoredTo to the SSE cursor or apply old event payloads.
		}
		if (event === null) await pause(); // Connection loss / generation drain.
	}
}
```

Call this with a synchronous renderer and a caller-owned `AbortController.signal`; abort it when the view closes, and handle the returned Promise's rejection. On 401, ask the human to sign in again. A failed snapshot stops this example rather than retrying authorization or bad data indefinitely. Render message bodies as text or through the normal sanitized Markdown renderer, never raw HTML.

Only one snapshot request or one stream is open at a time; no event queue or full-history cache accumulates. A busy board will cause repeated snapshot reads and stream connections. A production consumer can coalesce invalidations, but must invalidate in-flight snapshots on restore and preserve the same publication-cursor handoff. This example deliberately does not reconstruct an export from historical events or promise offline delivery.
