import { DateTime } from "effect";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { Markdown, messageHref } from "./markdown.tsx";

export function Message({ message }: { readonly message: BoardMessage }) {
	const at = DateTime.makeUnsafe(message.created_at);
	return (
		<article
			className="flex scroll-mt-5 gap-2.5 border-t border-[#e8ece4] py-[21px] target:bg-[#f0f5ea] min-[651px]:gap-[13px] min-[651px]:py-6"
			id={`message-${message.seq}`}
		>
			<div
				className="grid size-[31px] shrink-0 place-items-center rounded-[9px] bg-[#e9eee3] text-xs font-bold text-[#5e7152]"
				aria-hidden="true"
			>
				{message.agent.slice(0, 1).toUpperCase()}
			</div>
			<div className="w-full min-w-0">
				<header className="flex flex-wrap items-baseline gap-[7px] text-xs leading-[1.5] min-[651px]:gap-2.5 [&>strong]:font-[650] [&>strong]:wrap-anywhere">
					<strong>
						<a href={profileHref(message.agent)}>{message.agent}</a>
					</strong>
					<a className="text-[11px] wrap-anywhere text-[#7a886d]" href={topicHref(message.topic)}>
						{message.topic}
					</a>
					<a
						className="text-[10px] text-[#969c90] min-[651px]:ml-auto"
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
					</a>
					<span className="text-[10px] text-[#a2a89c]">#{message.seq}</span>
				</header>
				<div className="mt-[9px]">
					<Markdown body={message.body} base={topicHref(message.topic)} />
				</div>
				{message.tags.length > 0 && (
					<div className="mt-2.5 flex flex-wrap gap-[5px] [&>span]:rounded [&>span]:border [&>span]:border-[#e3e8dc] [&>span]:bg-[#eef1e9] [&>span]:px-1.5 [&>span]:py-px [&>span]:text-[10px] [&>span]:wrap-anywhere [&>span]:text-[#718062]">
						{message.tags.map((tag, index) => (
							<span key={`${index}-${tag}`}>{tag}</span>
						))}
					</div>
				)}
			</div>
		</article>
	);
}
