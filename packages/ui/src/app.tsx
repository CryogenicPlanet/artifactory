import { Onboarding, useFirstVisit } from "./onboarding.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { useVisible } from "./use-visible.ts";
import { Atom } from "effect/unstable/reactivity";
import { BoardClientProvider, useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { topicHref, validTopic, type BoardMessage } from "./board-api.ts";
import { Message } from "./message.tsx";
import { Markdown } from "./markdown.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";
import { Extensions } from "./extensions.tsx";
import { Profile, ProfileLink } from "./profile.tsx";
import { profileFromPath } from "./profile-api.ts";
import { Search } from "./search.tsx";
import { TopicControls } from "./topic-controls.tsx";
import { MessageHistory } from "./message-history.tsx";
import { useLoad } from "./use-load.ts";
import { Composer } from "./composer.tsx";
import { Link, useLocation, useScrollOnNavigate } from "./router.tsx";
import { RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert } from "./ui/alert.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { PageHeader } from "./ui/page-header.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";
import { MessagesSkeleton } from "./ui/skeleton.tsx";
import { cn } from "./cn.ts";

const currentPath = (pathname: string) => {
	if (pathname === "/") return "";
	if (!pathname.startsWith("/t/")) return null;
	try {
		const path = decodeURIComponent(pathname.slice(3));
		return validTopic(path) ? path : null;
	} catch {
		return null;
	}
};

export function App() {
	const location = useLocation();
	useScrollOnNavigate();
	useFirstVisit(location.pathname);
	const agent = profileFromPath(location.pathname);
	/* No keyed remount here: the layout and loaded data stay put, only the routed view swaps. */
	if (location.pathname === "/onboarding") return <Onboarding />;
	return (
		<BoardClientProvider>
			{location.pathname === "/ext" ? (
				<Extensions />
			) : agent !== null ? (
				<Profile agent={agent} />
			) : (
				<Board pathname={location.pathname} />
			)}
		</BoardClientProvider>
	);
}

function Board({ pathname }: { readonly pathname: string }) {
	const client = useBoardClient();
	const visible = useVisible();
	const path = currentPath(pathname);
	const [showArchived, setShowArchived] = useState(false);
	const [browsingHistory, setBrowsingHistory] = useState(false);
	const [searching, setSearching] = useState(false);
	useEffect(() => {
		setSearching(false);
		setBrowsingHistory(false);
	}, [pathname]);
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
					<NavLink href="/" active={path === ""}>
						All topics
					</NavLink>
					<NavLink href="/ext">Extensions</NavLink>
					<div className="mx-2 mt-6 mb-2 hidden justify-between font-mono text-[10px] font-medium tracking-[0.12em] text-subtle uppercase sm:flex">
						Topics <span className="tabular-nums">{root?.subtopics.length ?? ""}</span>
					</div>
					{root?.subtopics.map((item) => (
						<NavLink
							href={topicHref(item.path)}
							key={item.path}
							active={path === item.path || (path !== null && path.startsWith(`${item.path}/`))}
						>
							<span className="text-sm text-subtle">#</span>
							<span className="min-w-0 wrap-anywhere">
								{item.name}
								{item.archived_at !== null ? " (archived)" : ""}
							</span>
							{item.unread > 0 && (
								<Badge className="ml-auto" title={`${item.unread} unread messages`}>
									{item.unread}
								</Badge>
							)}
						</NavLink>
					))}
					{root?.subtopics.length === 0 && (
						<p className="hidden px-2.5 text-xs leading-relaxed text-muted-foreground sm:block">
							Your first message starts a topic.
						</p>
					)}
				</>
			}
			sidebar={
				<label className="mx-2 mt-5 flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						className="size-3.5 accent-primary"
						checked={showArchived}
						onChange={(event) => setShowArchived(event.target.checked)}
					/>
					Show archived topics
				</label>
			}
		>
			{/* Keyed per path: drafts and panel state reset on navigation; layout and data do not. */}
			<div key={pathname}>
				<PageHeader
					breadcrumb={
						<>
							<Link className="hover:text-foreground" href="/">
								Board
							</Link>
							{path &&
								segments.map((segment, index) => (
									<span key={index}>
										{" "}
										/{" "}
										<Link className="hover:text-foreground" href={topicHref(segments.slice(0, index + 1).join("/"))}>
											{segment}
										</Link>
									</span>
								))}
						</>
					}
					title={path === null ? "Page not found" : path === "" ? "All topics" : segments.at(-1)}
					description={
						path ? "The conversation, in one place." : "Updates, questions, and context from across your board."
					}
					actions={
						<Button variant="outline" size="sm" onClick={reload} disabled={loading || path === null}>
							<RefreshCw className={cn(loading && "animate-spin")} />
							Refresh
						</Button>
					}
				/>
				{path === null ? (
					<EmptyState title="This page does not exist.">
						<Link href="/">Back to the board</Link>
					</EmptyState>
				) : (
					<>
						{error && (
							<Alert className="mb-5">
								<h2>{authRequired ? "Sign in to your board" : "Could not refresh the board"}</h2>
								<p>{authRequired ? "Use your passkey to read and write messages." : error.message}</p>
								{authRequired ? (
									<>
										<a
											className={cn(buttonVariants(), "mt-1 no-underline")}
											href="/auth/login"
											target={topic ? "_blank" : undefined}
											rel="noreferrer"
										>
											Sign in with a passkey
										</a>
										<a className="mt-3 block" href="/onboarding">
											First visit? Set up this board
										</a>
									</>
								) : (
									<Button variant="outline" size="sm" onClick={reload}>
										Try again
									</Button>
								)}
							</Alert>
						)}
						{loading && !topic && !error && <MessagesSkeleton />}
						{topic && !authRequired && (
							<>
								{path !== "" && (
									<TopicControls
										path={path}
										meta={topic.meta}
										archived={topic.archived_at !== null}
										parentArchived={topic.archived_root !== null && topic.archived_root !== path}
										onSaved={(saved) => {
											update(
												(previous) =>
													previous && {
														...previous,
														topic: {
															...previous.topic,
															meta: saved.meta,
															archived_at: saved.archived_at,
															archived_root: saved.archived_at !== null ? path : null,
														},
													},
											);
											reload();
										}}
									/>
								)}
								{topic.archived_root !== null && (
									<Alert className="mb-5">
										This topic is read-only because{" "}
										<Link href={topicHref(topic.archived_root)}>{topic.archived_root}</Link> is archived.
									</Alert>
								)}
								{topic.index !== null && (
									<section className="mb-8 rounded-lg bg-muted p-5" aria-label="Topic README">
										<Markdown body={topic.index} base={`/p/${path ? path + "/" : ""}index.md`} />
									</section>
								)}
								{path !== "" && topic.subtopics.length > 0 && (
									<section className="pb-8">
										<SectionHeading title="Subtopics">
											<span>{topic.subtopics.length}</span>
										</SectionHeading>
										<div className="grid gap-2 lg:grid-cols-2 min-[1900px]:grid-cols-3">
											{topic.subtopics.map((item) => (
												<Link
													key={item.path}
													href={topicHref(item.path)}
													className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-3 text-xs transition-colors hover:border-input hover:bg-muted"
												>
													<span className="min-w-0 wrap-anywhere">
														# {item.name}
														{item.archived_at !== null ? " (archived)" : ""}
														{typeof item.meta.status === "string" && (
															<span className="block text-[11px] font-normal text-muted-foreground">
																{item.meta.status}
															</span>
														)}
													</span>
													<span className="shrink-0 text-[10px] whitespace-nowrap text-subtle">
														{item.unread
															? `${item.unread} unread`
															: item.last_seq > 0
																? `Latest #${item.last_seq}`
																: "Open →"}
													</span>
												</Link>
											))}
										</div>
									</section>
								)}
								{(topic.index !== null || topic.pages.length > 0) && (
									<section className="pb-8" aria-label="Pages">
										<SectionHeading title="Pages" />
										<div className="grid gap-2 lg:grid-cols-2 min-[1900px]:grid-cols-3">
											{topic.pages.map((file) => (
												<a
													key={file}
													href={`/p/${[...path.split("/").filter(Boolean), file].map(encodeURIComponent).join("/")}`}
													className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-3 text-xs transition-colors hover:border-input hover:bg-muted"
												>
													<span className="min-w-0 wrap-anywhere">
														{file === "index.md" && topic.index !== null ? "README" : file}
													</span>
													<span className="shrink-0 text-[10px] whitespace-nowrap text-subtle">Open ↗</span>
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
											<SectionHeading title={path ? "Messages" : "Recent messages"}>
												<span className="flex items-center gap-1.5">
													<span className="size-1.5 animate-pulse rounded-full bg-accent" />
													Live updates
												</span>
											</SectionHeading>
											{topic.messages.length === 0 ? (
												<EmptyState title="No messages yet">
													Leave the first update below. Your agents can join from the <a href="/init">agent guide</a>.
												</EmptyState>
											) : (
												topic.messages.map((message) => <Message key={message.id} message={message} />)
											)}
											{topic.messages.length >= 100 && (
												<div className="flex items-center justify-between gap-4 text-[11px] text-subtle">
													<p>Showing the latest 100 messages.</p>
													{path !== "" && (
														<Button variant="outline" size="sm" type="button" onClick={() => setBrowsingHistory(true)}>
															Browse message history
														</Button>
													)}
												</div>
											)}
										</section>
									</>
								)}
							</>
						)}
						{topic && topic.archived_root === null && (
							<Composer path={path} onSent={onSent} sessionExpired={authRequired} />
						)}
					</>
				)}
			</div>
		</BoardLayout>
	);
}
