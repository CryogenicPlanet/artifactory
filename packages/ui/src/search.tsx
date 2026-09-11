import { Effect } from "effect";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validTopic, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { searchMessages, type MessageFilters } from "./search-api.ts";
import "./search.css";

export function Search({ path, onActive }: { readonly path: string; readonly onActive: (active: boolean) => void }) {
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
			searchMessages(filters, since).pipe(
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
		<section className="board-search" aria-label="Message search">
			<details>
				<summary>Search messages</summary>
				<form onSubmit={submit}>
					<label>
						Words or phrases
						<input
							value={q}
							onChange={(event) => setQ(event.target.value)}
							maxLength={512}
							placeholder={'Try: release "ready to ship"'}
						/>
					</label>
					<div className="search-filters">
						<label>
							Search topic
							<input
								value={topic}
								onChange={(event) => setTopic(event.target.value)}
								maxLength={200}
								placeholder="All topics"
							/>
						</label>
						<label>
							Tag
							<input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="Any tag" />
						</label>
						<label>
							Author
							<input
								value={agent}
								onChange={(event) => setAgent(event.target.value)}
								maxLength={64}
								placeholder="Any agent"
							/>
						</label>
					</div>
					<p className="field-hint">
						Filters combine. Topic includes subtopics and archives. Words and quoted phrases search message bodies.
					</p>
					<button type="submit" disabled={loading}>
						{loading ? "Searching…" : "Search"}
					</button>
				</form>
			</details>
			{error && (
				<p className="notice error" role="alert">
					{error}
				</p>
			)}
			{applied && (
				<div className="search-results" aria-label="Search results">
					<div className="section-heading">
						<h2>Search results</h2>
						<button
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
					<p className="field-hint">
						{items.length} shown, oldest first. Search again to include new messages and edits.
					</p>
					{items.map((message) => (
						<Message key={message.id} message={message} />
					))}
					{!loading && !error && items.length === 0 && <p role="status">No messages match these filters.</p>}
					{loading && <p role="status">Loading results…</p>}
					{error && (
						<button type="button" onClick={() => load(applied, items.length ? cursor : 0)}>
							Retry search
						</button>
					)}
					{more && !error && (
						<button type="button" disabled={loading} onClick={() => load(applied, cursor)}>
							More results
						</button>
					)}
				</div>
			)}
		</section>
	);
}
