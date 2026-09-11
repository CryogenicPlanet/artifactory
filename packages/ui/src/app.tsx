import { BoardLayout } from "./board-layout.tsx";
import { useVisible } from "./use-visible.ts";
import { Atom } from "effect/unstable/reactivity";
import { useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useMemo, useState } from "react";
import { topicHref, validTopic, type BoardMessage } from "./board-api.ts";
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
	const client = useBoardClient();
	const visible = useVisible();
	const [path] = useState(currentPath);
	const [showArchived, setShowArchived] = useState(false);
	const [browsingHistory, setBrowsingHistory] = useState(false);
	const [searching, setSearching] = useState(false);
	const request = useMemo(() => {
		if (path === null) return Atom.make(Effect.succeed(null));
		const root = client.topic("", showArchived, visible && path === "" && !searching && !browsingHistory);
		const topic = path === "" ? root : client.topic(path, showArchived, visible && !searching && !browsingHistory);
		const read = Atom.make((get) =>
			Effect.all(
				{ root: get.result(root, { suspendOnWaiting: true }), topic: get.result(topic, { suspendOnWaiting: true }) },
				{ concurrency: "unbounded" },
			),
		);
		return Atom.readable(read.read, (refresh) => {
			refresh(root);
			if (topic !== root) refresh(topic);
		});
	}, [client, path, showArchived, searching, browsingHistory, visible]);
	const { value, error, loading, reload, update } = useLoad(request);
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
						className={`my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal ${path === "" ? "bg-[#e3ebdd] font-semibold text-[#36532e]" : ""}`}
						href="/"
						aria-current={path === "" ? "page" : undefined}
					>
						All topics
					</a>
					<a
						className="my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal"
						href="/ext"
					>
						Extensions
					</a>
					<div className="mx-2.5 mt-[25px] mb-[9px] hidden justify-between text-[10px] font-semibold tracking-[1.2px] text-[#7b8376] uppercase min-[651px]:flex">
						Topics <span>{root?.subtopics.length ?? ""}</span>
					</div>
					{root?.subtopics.map((item) => (
						<a
							className={`my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal [&>span:nth-child(2)]:min-w-0 [&>span:nth-child(2)]:wrap-anywhere ${path === item.path || path?.startsWith(`${item.path}/`) ? "bg-[#e3ebdd] font-semibold text-[#36532e]" : ""}`}
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
			<header className="mb-[30px] flex items-start justify-between gap-4 min-[651px]:mb-10 min-[651px]:items-center [&_p]:mt-2.5 [&_p]:text-xs [&_p]:leading-[1.6] [&_p]:text-[#7b8176] min-[651px]:[&_p]:text-[13px]">
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
					<h1 className="text-[26px] leading-[1.2] font-[650] tracking-[-0.9px] wrap-anywhere min-[651px]:text-[30px]">
						{path === null ? "Page not found" : path === "" ? "All topics" : segments.at(-1)}
					</h1>
					<p>{path ? "The conversation, in one place." : "Updates, questions, and context from across your board."}</p>
				</div>
				<button
					type="button"
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] disabled:cursor-default disabled:opacity-50 shrink-0 bg-transparent text-[12px] text-[#68705f]"
					onClick={reload}
					disabled={loading || path === null}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{path === null ? (
				<div className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]">
					<h2>This page does not exist.</h2>
					<a href="/">Back to the board</a>
				</div>
			) : (
				<>
					{error && (
						<div
							className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5 "
							role="alert"
						>
							<h2>{authRequired ? "Sign in to your board" : "Could not refresh the board"}</h2>
							<p>{authRequired ? "Use your passkey to read and write messages." : error.message}</p>
							{authRequired ? (
								<>
									<a
										className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold inline-block [&&]:no-underline text-[13px] border-[#4c6840] bg-[#4c6840] text-white [&:not(:disabled):hover]:bg-[#3c5631] [&:not(:disabled):hover]:text-white"
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
								<button
									className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
									type="button"
									onClick={reload}
								>
									Try again
								</button>
							)}
						</div>
					)}
					{loading && !topic && !error && (
						<p
							className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]"
							role="status"
						>
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
								<p className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5">
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
									<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
										<h2>Subtopics</h2>
										<span>{topic.subtopics.length}</span>
									</div>
									<div className="grid gap-2 min-[951px]:grid-cols-2 [&_a]:flex [&_a]:justify-between [&_a]:gap-3 [&_a]:rounded-[7px] [&_a]:border [&_a]:border-[#e3e7de] [&_a]:px-[14px] [&_a]:py-[13px] [&_a]:text-xs [&_a>span:first-child]:wrap-anywhere [&_a>span:last-child]:text-[10px] [&_a>span:last-child]:whitespace-nowrap [&_a>span:last-child]:text-[#87917c]">
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
									<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
										<h2>Pages</h2>
									</div>
									<div className="grid gap-2 min-[951px]:grid-cols-2 [&_a]:flex [&_a]:justify-between [&_a]:gap-3 [&_a]:rounded-[7px] [&_a]:border [&_a]:border-[#e3e7de] [&_a]:px-[14px] [&_a]:py-[13px] [&_a]:text-xs [&_a>span:first-child]:wrap-anywhere [&_a>span:last-child]:text-[10px] [&_a>span:last-child]:whitespace-nowrap [&_a>span:last-child]:text-[#87917c]">
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
										<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
											<h2>{path ? "Messages" : "Recent messages"}</h2>
											<span>Live updates</span>
										</div>
										{topic.messages.length === 0 ? (
											<div className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]">
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
													<button
														className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
														type="button"
														onClick={() => setBrowsingHistory(true)}
													>
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
