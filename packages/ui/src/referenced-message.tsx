import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { getMessageBySequence, type BoardMessage } from "./board-api.ts";
import { useLoad } from "./use-load.ts";
import { Message } from "./message.tsx";

export function ReferencedMessage({ visible }: { readonly visible: readonly BoardMessage[] }) {
	const [seq] = useState(() => {
		const value = new URLSearchParams(window.location.search).get("message");
		const parsed = value && /^[1-9][0-9]*$/.test(value) ? Number(value) : 0;
		return Number.isSafeInteger(parsed) ? parsed : 0;
	});
	const displayed = visible.some((item) => item.seq === seq);
	const request = useMemo(
		() => (!seq || displayed ? Effect.succeed(null) : getMessageBySequence(seq)),
		[seq, displayed, visible],
	);
	const { value: message, error } = useLoad(request);
	useEffect(() => {
		if (seq && (displayed || message?.seq)) document.getElementById(`message-${seq}`)?.scrollIntoView();
	}, [seq, displayed, message?.seq]);
	if (!seq || displayed) return null;
	return (
		<section aria-label="Referenced message" className="mb-8">
			<div className="section-heading">
				<h2>Referenced message #{seq}</h2>
			</div>
			{message && !error ? (
				<Message message={message} />
			) : (
				<p role="status">{error?.message ?? "Loading referenced message…"}</p>
			)}
		</section>
	);
}
