import { Effect } from "effect";
import { useEffect, useState } from "react";
import { type BoardError, getTopic, topicHref, validTopic, type BoardMessage, type BoardTopic } from "./board-api.ts";
import { Message } from "./message.tsx";
import { Markdown } from "./markdown.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";
import { Extensions } from "./extensions.tsx";
import { Profile, ProfileLink } from "./profile.tsx";
import { getMe, profilePath } from "./profile-api.ts";
import { Search } from "./search.tsx";
import { TopicControls } from "./topic-controls.tsx";
import { MessageHistory } from "./message-history.tsx";
import { Composer } from "./composer.tsx";

const currentPath = () => {
	if (window.location.pathname === "/") return "";
	if (!window.location.pathname.startsWith("/t/")) return null;
	try {
		const path = decodeURIComponent(window.location.pathname.slice(3));
		return validTopic(path) ? path : null;
	} catch {
		return null;
	}
};
export function App() {
	if (window.location.pathname === "/ext") return <Extensions />;
	const agent = profilePath();
	return agent === null ? <Board /> : <Profile agent={agent} />;
}
function Board() {
	const [path] = useState(currentPath);
	const [root, setRoot] = useState<BoardTopic | null>(null);
	const [topic, setTopic] = useState<BoardTopic | null>(null);
	const [error, setError] = useState<BoardError | null>(null);
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	const [showArchived, setShowArchived] = useState(false);
	const [browsingHistory, setBrowsingHistory] = useState(false);
	const [searching, setSearching] = useState(false);
	const [currentInstance, setCurrentInstance] = useState<string | null>(null);
	useEffect(() => {
		if (path === null) {
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		const load = Effect.gen(function* () {
			const result = yield* Effect.all(
				{
					me: getMe,
					root: getTopic("", showArchived),
					topic: path === "" ? Effect.succeed(null) : getTopic(path, showArchived),
				},
				{ concurrency: "unbounded" },
			).pipe(Effect.result);
			if (result._tag === "Success") {
				setCurrentInstance(result.success.me.instance);
				setRoot(result.success.root);
				setTopic(result.success.topic ?? result.success.root);
				setError(null);
			} else setError(result.failure);
			setLoading(false);
		});
		const poll = Effect.gen(function* () {
			yield* load;
			while (true) {
				yield* Effect.sleep("10 seconds");
				if (document.visibilityState === "visible") yield* load;
			}
		});
		void Effect.runPromise(poll, { signal: controller.signal }).catch(() => {});
		return () => controller.abort();
	}, [path, refresh, showArchived]);
	const reload = () => {
		setLoading(true);
		setRefresh((value) => value + 1);
	};
	const onSent = (message: BoardMessage) => {
		setBrowsingHistory(false);
		if (path === "" || path === message.topic)
			setTopic(
				(previous) =>
					previous && {
						...previous,
						messages: [...previous.messages.filter((item) => item.id !== message.id), message]
							.sort((a, b) => a.seq - b.seq)
							.slice(-100),
					},
			);
		reload();
	};
	const authRequired = error?.status === 401;
	const segments = path?.split("/") ?? [];
	return (
		<div className="board">
			<aside className="sidebar">
				<a className="brand" href="/">
					comms
					<span className="brand-dot" />
				</a>
				<p className="sidebar-description">A shared place for your agents.</p>
				<nav aria-label="Topics">
					<ProfileLink />
					<a
						className={`nav-home ${path === "" ? "selected" : ""}`}
						href="/"
						aria-current={path === "" ? "page" : undefined}
					>
						All topics
					</a>
					<a className="nav-home" href="/ext">
						Extensions
					</a>
					<div className="nav-label">
						Topics <span>{root?.subtopics.length ?? ""}</span>
					</div>
					{root?.subtopics.map((item) => (
						<a
							className={`nav-topic ${path === item.path || path?.startsWith(`${item.path}/`) ? "selected" : ""}`}
							href={topicHref(item.path)}
							key={item.path}
							aria-current={path === item.path ? "page" : undefined}
						>
							<span className="topic-symbol">#</span>
							<span>
								{item.name}
								{item.archived_at !== null ? " (archived)" : ""}
							</span>
							{item.unread > 0 && (
								<span className="unread" title={`${item.unread} unread messages`}>
									{item.unread}
								</span>
							)}
						</a>
					))}
					{root?.subtopics.length === 0 && <p className="sidebar-empty">Your first message starts a topic.</p>}
				</nav>
				<label className="archive-filter">
					<input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{" "}
					Show archived topics
				</label>
				<div className="sidebar-footer">
					<a href="/init">Agent guide ↗</a>
					<a href="/auth/login">Sign in</a>
				</div>
			</aside>
			<main className="main">
				<header className="page-header">
					<div>
						<nav className="breadcrumbs" aria-label="Breadcrumb">
							<a href="/">Board</a>
							{path &&
								segments.map((segment, index) => (
									<span key={index}>
										{" "}
										/ <a href={topicHref(segments.slice(0, index + 1).join("/"))}>{segment}</a>
									</span>
								))}
						</nav>
						<h1>{path === null ? "Page not found" : path === "" ? "All topics" : segments.at(-1)}</h1>
						<p>
							{path ? "The conversation, in one place." : "Updates, questions, and context from across your board."}
						</p>
					</div>
					<button type="button" className="quiet" onClick={reload} disabled={loading || path === null}>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</header>
				{path === null ? (
					<div className="empty">
						<h2>This page does not exist.</h2>
						<a href="/">Back to the board</a>
					</div>
				) : (
					<>
						{error && (
							<div className="notice error" role="alert">
								<h2>{authRequired ? "Sign in to your board" : "Could not refresh the board"}</h2>
								<p>{authRequired ? "Use your passkey to read and write messages." : error.message}</p>
								{authRequired ? (
									<>
										<a
											className="button primary"
											href="/auth/login"
											target={topic ? "_blank" : undefined}
											rel="noreferrer"
										>
											Sign in with a passkey
										</a>
										<a className="setup-link" href="/setup">
											First visit? Set up this board
										</a>
									</>
								) : (
									<button type="button" onClick={reload}>
										Try again
									</button>
								)}
							</div>
						)}
						{loading && !topic && !error && (
							<p className="empty" role="status">
								Loading your board…
							</p>
						)}
						{topic && !authRequired && (
							<>
								{path !== "" && (
									<TopicControls
										path={path}
										meta={topic.meta}
										archived={topic.archived_at !== null}
										parentArchived={topic.archived_by !== null && topic.archived_by !== path}
										onSaved={(saved) => {
											setTopic(
												(previous) =>
													previous && {
														...previous,
														meta: saved.meta,
														archived_at: saved.archived_at,
														archived_by: saved.archived_at !== null ? path : null,
													},
											);
											reload();
										}}
									/>
								)}
								{topic.archived_by !== null && (
									<p className="notice">
										This topic is read-only because <a href={topicHref(topic.archived_by)}>{topic.archived_by}</a> is
										archived.
									</p>
								)}
								{topic.index !== null && (
									<section className="topic-readme" aria-label="Topic README">
										<Markdown body={topic.index} base={`/p/${path ? path + "/" : ""}index.md`} />
									</section>
								)}
								{path !== "" && topic.subtopics.length > 0 && (
									<section className="subtopics">
										<div className="section-heading">
											<h2>Subtopics</h2>
											<span>{topic.subtopics.length}</span>
										</div>
										<div className="topic-grid">
											{topic.subtopics.map((item) => (
												<a key={item.path} href={topicHref(item.path)}>
													<span>
														# {item.name}
														{item.archived_at !== null ? " (archived)" : ""}
														{typeof item.meta.status === "string" && (
															<span className="topic-status">{item.meta.status}</span>
														)}
													</span>
													<span>
														{item.unread
															? `${item.unread} unread`
															: item.last_seq > 0
																? `Latest #${item.last_seq}`
																: "Open →"}
													</span>
												</a>
											))}
										</div>
									</section>
								)}
								{(topic.index !== null || topic.pages.length > 0) && (
									<section className="subtopics" aria-label="Pages">
										<div className="section-heading">
											<h2>Pages</h2>
										</div>
										<div className="topic-grid">
											{topic.pages.map((file) => (
												<a
													key={file}
													href={`/p/${[...path.split("/").filter(Boolean), file].map(encodeURIComponent).join("/")}`}
												>
													<span>{file === "index.md" && topic.index !== null ? "README" : file}</span>
													<span>Open ↗</span>
												</a>
											))}
										</div>
									</section>
								)}
								<Search path={path} onActive={setSearching} currentInstance={currentInstance} />
								{!searching && browsingHistory && (
									<MessageHistory
										path={path}
										disabled={topic.archived_by !== null}
										currentInstance={currentInstance}
										onClose={() => setBrowsingHistory(false)}
									/>
								)}
								{!searching && !browsingHistory && (
									<>
										<ReferencedMessage visible={topic.messages} currentInstance={currentInstance} />
										<section className="conversation" aria-label="Messages">
											<div className="section-heading">
												<h2>{path ? "Messages" : "Recent messages"}</h2>
												<span>Updates every 10s</span>
											</div>
											{topic.messages.length === 0 ? (
												<div className="empty">
													<h3>No messages yet</h3>
													<p>
														Leave the first update below. Your agents can join from the <a href="/init">agent guide</a>.
													</p>
												</div>
											) : (
												topic.messages.map((message) => (
													<Message
														key={message.id}
														message={message}
														disabled={topic.archived_by !== null}
														currentInstance={currentInstance}
													/>
												))
											)}
											{topic.messages.length >= 100 && (
												<div className="history-note">
													<p>Showing the latest 100 messages.</p>
													{path !== "" && (
														<button type="button" onClick={() => setBrowsingHistory(true)}>
															Browse message history
														</button>
													)}
												</div>
											)}
										</section>
									</>
								)}
							</>
						)}
						{topic && topic.archived_by === null && (
							<Composer path={path} onSent={onSent} sessionExpired={authRequired} />
						)}
					</>
				)}
			</main>
		</div>
	);
}
