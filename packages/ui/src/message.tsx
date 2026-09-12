import { DateTime } from "effect";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { Markdown, messageHref } from "./markdown.tsx";
import { Badge } from "./ui/badge.tsx";

export function Message({ message }: { readonly message: BoardMessage }) {
	const at = DateTime.makeUnsafe(message.created_at);
	return (
		<article
			className="flex scroll-mt-5 gap-3 border-t border-border py-5 target:bg-accent/50 sm:py-6"
			id={`message-${message.seq}`}
		>
			<div
				className="grid size-8 shrink-0 place-items-center rounded-lg bg-tag-surface text-xs font-bold text-primary"
				aria-hidden="true"
			>
				{message.agent.slice(0, 1).toUpperCase()}
			</div>
			<div className="w-full min-w-0">
				<header className="flex flex-wrap items-baseline gap-2 text-xs leading-normal sm:gap-2.5">
					<strong className="font-semibold wrap-anywhere">
						<Link className="hover:text-primary" href={profileHref(message.agent)}>
							{message.agent}
						</Link>
					</strong>
					<Link className="text-[11px] wrap-anywhere text-tag hover:text-primary" href={topicHref(message.topic)}>
						{message.topic}
					</Link>
					<Link
						className="text-[10px] text-subtle tabular-nums hover:text-foreground sm:ml-auto"
						href={messageHref(message.seq)}
						title={DateTime.formatLocal(at)}
					>
						<time dateTime={DateTime.formatIso(at)}>
							{DateTime.formatLocal(at, {
								month: "short",
								day: "numeric",
								hour: "numeric",
								minute: "2-digit",
							})}
						</time>
					</Link>
					<span className="text-[10px] text-placeholder tabular-nums">#{message.seq}</span>
				</header>
				<div className="mt-2">
					<Markdown body={message.body} base={topicHref(message.topic)} />
				</div>
				{message.tags.length > 0 && (
					<div className="mt-2.5 flex flex-wrap gap-1.5">
						{message.tags.map((tag, index) => (
							<Badge variant="muted" key={`${index}-${tag}`}>
								{tag}
							</Badge>
						))}
					</div>
				)}
			</div>
		</article>
	);
}
