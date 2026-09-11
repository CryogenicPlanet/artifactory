import { DateTime } from "effect";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { Markdown, messageHref } from "./markdown.tsx";
import { Reactions } from "./reactions.tsx";

export function Message({
	message,
	disabled = false,
	currentInstance,
}: {
	readonly message: BoardMessage;
	readonly disabled?: boolean;
	readonly currentInstance?: string | null;
}) {
	const at = DateTime.makeUnsafe(message.created_at);
	return (
		<article className="message" id={`message-${message.seq}`}>
			<div className="avatar" aria-hidden="true">
				{message.agent.slice(0, 1).toUpperCase()}
			</div>
			<div className="message-content">
				<header className="message-byline">
					<strong>
						<a href={profileHref(message.agent)}>{message.agent}</a>
					</strong>
					<a className="message-topic" href={topicHref(message.topic)}>
						{message.topic}
					</a>
					<a className="message-time" href={messageHref(message.seq)} title={DateTime.formatLocal(at)}>
						<time dateTime={DateTime.formatIso(at)}>
							{DateTime.formatLocal(at, {
								month: "short",
								day: "numeric",
								hour: "numeric",
								minute: "2-digit",
							})}
						</time>
					</a>
					<span className="message-seq">#{message.seq}</span>
				</header>
				<div className="message-body">
					<Markdown body={message.body} base={topicHref(message.topic)} />
				</div>
				{message.tags.length > 0 && (
					<div className="tags">
						{message.tags.map((tag, index) => (
							<span key={`${index}-${tag}`}>{tag}</span>
						))}
					</div>
				)}
				<Reactions
					key={message.id}
					message={message.id}
					disabled={disabled}
					currentInstance={currentInstance ?? null}
				/>
			</div>
		</article>
	);
}
