import { BoardLayout } from "./board-layout.tsx";
import { Effect } from "effect";
import { useMemo, useState } from "react";
import { getTopic, topicHref, validTopic, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { Markdown } from "./markdown.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";
import { Extensions } from "./extensions.tsx";
import { Profile, ProfileLink } from "./profile.tsx";
import { profilePath } from "./profile-api.ts";
import { Search } from "./search.tsx";
import { TopicControls } from "./topic-controls.tsx";
import { MessageHistory } from "./message-history.tsx";
import { useLoad } from "./use-load.ts";
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
	const [showArchived, setShowArchived] = useState(false);
	const [browsingHistory, setBrowsingHistory] = useState(false);
	const [searching, setSearching] = useState(false);
	const request = useMemo(
		() =>
			path === null
				? Effect.succeed(null)
				: Effect.all(
						{
							root: getTopic("", showArchived, path === "" && !searching && !browsingHistory),
							topic: path === "" ? Effect.succeed(null) : getTopic(path, showArchived, !searching && !browsingHistory),
						},
						{ concurrency: "unbounded" },
					).pipe(Effect.map(({ root, topic }) => ({ root, topic: topic ?? root }))),
		[path, showArchived, searching, browsingHistory],
	);
	const { value, error, loading, reload, update } = useLoad(request, path !== null);
	const root = value?.root;
	const topic = value?.topic;
	const onSent = (message: BoardMessage) => {
		setBrowsingHistory(false);
		if (path === "" || path === message.topic)
			update(
				(previous) =>
					previous && {
						...previous,
						topic: {
							...previous.topic,
							messages: [...previous.topic.messages.filter((item) => item.id !== message.id), message]
								.sort((a, b) => a.seq - b.seq)
								.slice(-100),
						},
					},
			);
		reload();
	};
	const authRequired = error?.status === 401;
	const segments = path?.split("/") ?? [];
	return (
		<BoardLayout
			navigation={
				<>
					<ProfileLink />
					<a
						className={`nav-home ${path === "" ? "bg-[#e3ebdd] font-semibold text-[#36532e]" : ""}`}
						href="/"
						aria-current={path === "" ? "page" : undefined}
					>
						All topics
					</a>
					<a className="nav-home" href="/ext">
						Extensions
					</a>
					<div className="mx-2.5 mt-[25px] mb-[9px] hidden justify-between text-[10px] font-semibold tracking-[1.2px] text-[#7b8376] uppercase min-[651px]:flex">
						Topics <span>{root?.subtopics.length ?? ""}</span>
					</div>
					{root?.subtopics.map((item) => (
						<a
							className={`nav-topic ${path === item.path || path?.startsWith(`${item.path}/`) ? "bg-[#e3ebdd] font-semibold text-[#36532e]" : ""}`}
							href={topicHref(item.path)}
							key={item.path}
							aria-current={path === item.path ? "page" : undefined}
						>
							<span className="text-base text-[#929b8a]">#</span>
							<span>
								{item.name}
								{item.archived_at !== null ? " (archived)" : ""}
							</span>
							{item.unread > 0 && (
								<span
									className="ml-auto shrink-0 rounded-[5px] bg-[#dae5d2] px-[5px] py-px text-[10px]"
									title={`${item.unread} unread messages`}
								>
									{item.unread}
								</span>
							)}
						</a>
					))}
					{root?.subtopics.length === 0 && (
						<p className="hidden px-2.5 text-xs leading-[1.6] text-[#757e70] min-[651px]:block">
							Your first message starts a topic.
						</p>
					)}
				</>
			}
			sidebar={
				<label className="mx-2 mt-5 flex items-center gap-1.5 text-xs text-[#68705f]">
					<input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{" "}
					Show archived topics
				</label>
			}
		>
			<header className="page-header">
				<div>
					<nav className="mb-2.5 text-[11px] wrap-anywhere text-[#858b80] min-[651px]:mb-4" aria-label="Breadcrumb">
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
					<p>{path ? "The conversation, in one place." : "Updates, questions, and context from across your board."}</p>
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
									<a className="mt-[14px] block" href="/setup">
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
										update(
											(previous) =>
												previous && {
													...previous,
													topic: {
														...previous.topic,
														meta: saved.meta,
														archived_at: saved.archived_at,
														archived_by: saved.archived_at !== null ? path : null,
													},
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
								<section className="mb-8 rounded-[7px] bg-[#f2f5ef] p-5" aria-label="Topic README">
									<Markdown body={topic.index} base={`/p/${path ? path + "/" : ""}index.md`} />
								</section>
							)}
							{path !== "" && topic.subtopics.length > 0 && (
								<section className="pb-8">
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
														<span className="block text-[11px] font-normal text-[#68705f]">{item.meta.status}</span>
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
								<section className="pb-8" aria-label="Pages">
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
							<Search path={path} onActive={setSearching} />
							{!searching && browsingHistory && (
								<MessageHistory path={path} onClose={() => setBrowsingHistory(false)} />
							)}
							{!searching && !browsingHistory && (
								<>
									<ReferencedMessage visible={topic.messages} />
									<section className="mb-8" aria-label="Messages">
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
											topic.messages.map((message) => <Message key={message.id} message={message} />)
										)}
										{topic.messages.length >= 100 && (
											<div className="text-[11px] text-[#89917f]">
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
		</BoardLayout>
	);
}
