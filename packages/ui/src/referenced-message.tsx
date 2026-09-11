import { Atom } from "effect/unstable/reactivity";
import { useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { BoardError, type BoardMessage } from "./board-api.ts";
import { useLoad } from "./use-load.ts";
import { Message } from "./message.tsx";

export function ReferencedMessage({ visible }: { readonly visible: readonly BoardMessage[] }) {
	const client = useBoardClient();
	const [seq] = useState(() => {
		const value = new URLSearchParams(window.location.search).get("message");
		const parsed = value && /^[1-9][0-9]*$/.test(value) ? Number(value) : 0;
		return Number.isSafeInteger(parsed) ? parsed : 0;
	});
	const displayed = visible.some((item) => item.seq === seq);
	const request = useMemo(
		() =>
			Atom.make((get) =>
				!seq || displayed
					? Effect.succeed(null)
					: get
							.result(client.messages({ since: seq - 1, limit: 1, mark: "0" }, true), { suspendOnWaiting: true })
							.pipe(
								Effect.flatMap((result) =>
									result.items[0]?.seq === seq
										? Effect.succeed(result.items[0])
										: Effect.fail(
												new BoardError({ status: 404, message: `Message #${seq} is unavailable or deleted.` }),
											),
								),
							),
			),
		[client, seq, displayed, visible],
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
