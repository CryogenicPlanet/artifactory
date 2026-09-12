import { Effect } from "effect";
import { ChevronRight, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validTopic, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { useBoardClient } from "./board-client.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

type MessageFilters = { readonly q: string; readonly topic: string; readonly tag: string; readonly agent: string };

const labelClass = "block text-[11px] font-semibold text-muted-foreground [&>input]:mt-1.5 [&>input]:font-normal";

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
		<section className="mb-7" aria-label="Message search">
			<details className="group rounded-lg border border-border bg-card px-4 py-3">
				<summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
					<SearchIcon className="size-3.5" />
					Search messages
					<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
				</summary>
				<form className="mt-4" onSubmit={submit}>
					<label className={labelClass}>
						Words or phrases
						<Input
							value={q}
							onChange={(event) => setQ(event.target.value)}
							maxLength={512}
							placeholder={'Try: release "ready to ship"'}
						/>
					</label>
					<div className="mt-2.5 grid gap-2.5 sm:grid-cols-[2fr_1fr_1fr]">
						<label className={labelClass}>
							Search topic
							<Input
								value={topic}
								onChange={(event) => setTopic(event.target.value)}
								maxLength={200}
								placeholder="All topics"
							/>
						</label>
						<label className={labelClass}>
							Tag
							<Input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="Any tag" />
						</label>
						<label className={labelClass}>
							Author
							<Input
								value={agent}
								onChange={(event) => setAgent(event.target.value)}
								maxLength={64}
								placeholder="Any agent"
							/>
						</label>
					</div>
					<p className="mt-1.5 mb-3 text-[10px] leading-relaxed text-subtle">
						Filters combine. Topic includes subtopics and archives. Words and quoted phrases search message bodies.
					</p>
					<Button variant="outline" size="sm" type="submit" disabled={loading}>
						{loading ? "Searching…" : "Search"}
					</Button>
				</form>
			</details>
			{error && <Alert className="mt-4">{error}</Alert>}
			{applied && (
				<div className="mt-6" aria-label="Search results">
					<SectionHeading title="Search results">
						<Button
							variant="outline"
							size="sm"
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
						</Button>
					</SectionHeading>
					<p className="mt-1.5 mb-2 text-[10px] leading-relaxed text-subtle">
						{items.length} shown, oldest first. Search again to include new messages and edits.
					</p>
					{items.map((message) => (
						<Message key={message.id} message={message} />
					))}
					{!loading && !error && items.length === 0 && <p role="status">No messages match these filters.</p>}
					{loading && <p role="status">Loading results…</p>}
					{error && (
						<Button variant="outline" size="sm" type="button" onClick={() => load(applied, items.length ? cursor : 0)}>
							Retry search
						</Button>
					)}
					{more && !error && (
						<Button variant="outline" size="sm" type="button" disabled={loading} onClick={() => load(applied, cursor)}>
							More results
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
