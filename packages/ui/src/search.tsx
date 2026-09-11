import { Effect } from "effect";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validTopic, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { useBoardClient } from "./board-client.tsx";
type MessageFilters = { readonly q: string; readonly topic: string; readonly tag: string; readonly agent: string };

export function Search({ path, onActive }: { readonly path: string; readonly onActive: (active: boolean) => void }) {
	const client = useBoardClient();
	const [q, setQ] = useState("");
	const [topic, setTopic] = useState(path);
	const [tag, setTag] = useState("");
	const [agent, setAgent] = useState("");
	const [applied, setApplied] = useState<MessageFilters | null>(null);
	const [items, setItems] = useState<readonly BoardMessage[]>([]);
	const [cursor, setCursor] = useState(0);
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const request = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			request.current?.abort();
			onActive(false);
		},
		[onActive],
	);
	const load = (filters: MessageFilters, since: number) => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError("");
		void Effect.runPromise(
			client
				.read(
					client.messages({
						since,
						limit: 100,
						recursive: "1",
						mark: "0",
						...(filters.q ? { q: filters.q } : {}),
						...(filters.topic ? { topic: filters.topic } : {}),
						...(filters.tag ? { tag: filters.tag } : {}),
						...(filters.agent ? { agent: filters.agent } : {}),
					}),
				)
				.pipe(
					Effect.match({
						onSuccess: (result) => {
							setItems((previous) => (since === 0 ? result.items : [...previous, ...result.items]));
							setCursor(result.cursor);
							setMore(result.items.length === 100);
							setLoading(false);
						},
						onFailure: (failure) => {
							setError(failure.message);
							setLoading(false);
						},
					}),
				),
			{ signal: controller.signal },
		).catch(() => {});
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (topic && !validTopic(topic)) {
			setError("Enter a valid topic path or leave it blank for the whole board.");
			return;
		}
		const filters = { q: q.trim(), topic, tag, agent: agent.trim() };
		setApplied(filters);
		setItems([]);
		setMore(false);
		onActive(true);
		load(filters, 0);
	};
	return (
		<section
			className="mb-7 [&_summary]:cursor-pointer [&_summary]:text-[13px] [&_summary]:font-semibold [&_form]:mt-4"
			aria-label="Message search"
		>
			<details>
				<summary>Search messages</summary>
				<form onSubmit={submit}>
					<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]">
						Words or phrases
						<input
							className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
							value={q}
							onChange={(event) => setQ(event.target.value)}
							maxLength={512}
							placeholder={'Try: release "ready to ship"'}
						/>
					</label>
					<div className="mt-3 grid gap-2.5 min-[651px]:grid-cols-[2fr_1fr_1fr]">
						<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]">
							Search topic
							<input
								className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
								value={topic}
								onChange={(event) => setTopic(event.target.value)}
								maxLength={200}
								placeholder="All topics"
							/>
						</label>
						<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]">
							Tag
							<input
								className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
								value={tag}
								onChange={(event) => setTag(event.target.value)}
								placeholder="Any tag"
							/>
						</label>
						<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]">
							Author
							<input
								className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
								value={agent}
								onChange={(event) => setAgent(event.target.value)}
								maxLength={64}
								placeholder="Any agent"
							/>
						</label>
					</div>
					<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
						Filters combine. Topic includes subtopics and archives. Words and quoted phrases search message bodies.
					</p>
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="submit"
						disabled={loading}
					>
						{loading ? "Searching…" : "Search"}
					</button>
				</form>
			</details>
			{error && (
				<p
					className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5 "
					role="alert"
				>
					{error}
				</p>
			)}
			{applied && (
				<div className="mt-6" aria-label="Search results">
					<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
						<h2>Search results</h2>
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							onClick={() => {
								request.current?.abort();
								setLoading(false);
								setApplied(null);
								setError("");
								onActive(false);
							}}
						>
							Back to conversation
						</button>
					</div>
					<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
						{items.length} shown, oldest first. Search again to include new messages and edits.
					</p>
					{items.map((message) => (
						<Message key={message.id} message={message} />
					))}
					{!loading && !error && items.length === 0 && <p role="status">No messages match these filters.</p>}
					{loading && <p role="status">Loading results…</p>}
					{error && (
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							onClick={() => load(applied, items.length ? cursor : 0)}
						>
							Retry search
						</button>
					)}
					{more && !error && (
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							disabled={loading}
							onClick={() => load(applied, cursor)}
						>
							More results
						</button>
					)}
				</div>
			)}
		</section>
	);
}
