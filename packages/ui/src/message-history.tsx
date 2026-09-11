import { Effect } from "effect";
import { useEffect, useState } from "react";
import { getMessageHistory, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";

export function MessageHistory({
	path,
	disabled,
	currentInstance,
	onClose,
}: {
	readonly path: string;
	readonly disabled: boolean;
	readonly currentInstance: string | null;
	readonly onClose: () => void;
}) {
	const [position, setPosition] = useState<{ readonly since: number; readonly previous: readonly number[] }>({
		since: 0,
		previous: [],
	});
	const [page, setPage] = useState<{ readonly items: readonly BoardMessage[]; readonly cursor: number } | null>(null);
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setPage(null);
		setError("");
		void Effect.runPromise(
			getMessageHistory(path, position.since).pipe(
				Effect.match({
					onSuccess: setPage,
					onFailure: (failure) => setError(failure.message),
				}),
			),
			{ signal: controller.signal },
		).catch(() => {});
		return () => controller.abort();
	}, [path, position.since, retry]);
	return (
		<>
			{page && <ReferencedMessage visible={page.items} currentInstance={currentInstance} />}
			<section className="conversation" aria-label="Message history">
				<div className="section-heading">
					<h2>Message history</h2>
					<button type="button" onClick={onClose}>
						Back to latest
					</button>
				</div>
				<p className="history-note">
					Page {position.previous.length + 1}, oldest first. Return to latest for live updates.
				</p>
				{error ? (
					<div className="notice error" role="alert">
						<p>{error}</p>
						<button type="button" onClick={() => setRetry((value) => value + 1)}>
							Retry history
						</button>
					</div>
				) : page === null ? (
					<p role="status">Loading history…</p>
				) : (
					<>
						{page.items.map((message) => (
							<Message key={message.id} message={message} disabled={disabled} currentInstance={currentInstance} />
						))}
						{page.items.length < 100 && <p role="status">You have reached the end of this topic’s history.</p>}
					</>
				)}
				<div className="section-heading">
					<button
						type="button"
						disabled={position.previous.length === 0}
						onClick={() => {
							const since = position.previous.at(-1);
							if (since !== undefined) setPosition({ since, previous: position.previous.slice(0, -1) });
						}}
					>
						Previous page
					</button>
					<button
						type="button"
						disabled={page === null || page.items.length < 100}
						onClick={() => {
							if (page) setPosition({ since: page.cursor, previous: [...position.previous, position.since] });
						}}
					>
						Next page
					</button>
				</div>
			</section>
		</>
	);
}
