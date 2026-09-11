import { Effect } from "effect";
import { useEffect, useState } from "react";
import { getMessageBySequence, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";

export function ReferencedMessage({ visible }: { readonly visible: readonly BoardMessage[] }) {
	const [seq] = useState(() => {
		const value = new URLSearchParams(window.location.search).get("message");
		const parsed = value && /^[1-9][0-9]*$/.test(value) ? Number(value) : 0;
		return Number.isSafeInteger(parsed) ? parsed : 0;
	});
	const [message, setMessage] = useState<BoardMessage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const displayed = visible.some((item) => item.seq === seq);
	useEffect(() => {
		if (!seq || displayed) return;
		const controller = new AbortController();
		void Effect.runPromise(
			getMessageBySequence(seq).pipe(
				Effect.match({
					onSuccess: (value) => {
						setMessage(value);
						setError(null);
					},
					onFailure: (failure) => {
						setMessage(null);
						setError(failure.message);
					},
				}),
			),
			{ signal: controller.signal },
		).catch(() => {});
		return () => controller.abort();
	}, [seq, displayed, visible]);
	useEffect(() => {
		if (seq && (displayed || message?.seq)) document.getElementById(`message-${seq}`)?.scrollIntoView();
	}, [seq, displayed, message?.seq]);
	if (!seq || displayed) return null;
	return (
		<section aria-label="Referenced message" className="conversation">
			<div className="section-heading">
				<h2>Referenced message #{seq}</h2>
			</div>
			{message ? <Message message={message} /> : <p role="status">{error ?? "Loading referenced message…"}</p>}
		</section>
	);
}
