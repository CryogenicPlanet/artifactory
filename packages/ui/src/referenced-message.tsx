import { Atom } from "effect/unstable/reactivity";
import { useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useEffect, useMemo } from "react";
import { BoardError, type BoardMessage } from "./board-api.ts";
import { useLocation } from "./router.tsx";
import { useLoad } from "./use-load.ts";
import { Message } from "./message.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

export function ReferencedMessage({ visible }: { readonly visible: readonly BoardMessage[] }) {
	const client = useBoardClient();
	const { search } = useLocation();
	const seq = useMemo(() => {
		const value = new URLSearchParams(search).get("message");
		const parsed = value && /^[1-9][0-9]*$/.test(value) ? Number(value) : 0;
		return Number.isSafeInteger(parsed) ? parsed : 0;
	}, [search]);
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
			<SectionHeading title={`Referenced message #${seq}`} />
			{message && !error ? (
				<Message message={message} />
			) : (
				<p className="text-[13px] text-muted-foreground" role="status">
					{error?.message ?? "Loading referenced message…"}
				</p>
			)}
		</section>
	);
}
