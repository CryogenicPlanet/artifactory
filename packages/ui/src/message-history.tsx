import { useMemo, useState } from "react";
import { useBoardClient } from "./board-client.tsx";
import { useLoad } from "./use-load.ts";
import { Message } from "./message.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";

export function MessageHistory({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
	const client = useBoardClient();
	const [position, setPosition] = useState<{ readonly since: number; readonly previous: readonly number[] }>({
		since: 0,
		previous: [],
	});
	const request = useMemo(
		() => client.messages({ topic: path, since: position.since, limit: 100, mark: "0" }),
		[client, path, position.since],
	);
	const { value, error, loading, reload } = useLoad(request);
	const page = loading || error ? undefined : value;
	return (
		<>
			{page && <ReferencedMessage visible={page.items} />}
			<section className="mb-8" aria-label="Message history">
				<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
					<h2>Message history</h2>
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="button"
						onClick={onClose}
					>
						Back to latest
					</button>
				</div>
				<p className="text-[11px] text-[#89917f]">
					Page {position.previous.length + 1}, oldest first. Return to latest for live updates.
				</p>
				{error ? (
					<div
						className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5 "
						role="alert"
					>
						<p>{error.message}</p>
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							onClick={reload}
						>
							Retry history
						</button>
					</div>
				) : page === undefined ? (
					<p role="status">Loading history…</p>
				) : (
					<>
						{page.items.map((message) => (
							<Message key={message.id} message={message} />
						))}
						{page.items.length < 100 && <p role="status">You have reached the end of this topic’s history.</p>}
					</>
				)}
				<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
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
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="button"
						disabled={page === undefined || page.items.length < 100}
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
