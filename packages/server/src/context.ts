import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { activity } from "./context-activity.ts";
import { identity, integer } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Messages, validTopic } from "./kernel/messages.ts";
import { Topics } from "./kernel/topics.ts";

/** Composes published read services without advancing the caller's read marks. */
export const context = Effect.gen(function* () {
	const who = yield* identity("read");
	const request = yield* HttpServerRequest.HttpServerRequest;
	const params = new URL(request.url, "http://localhost").searchParams;
	const budget = integer(params.get("budget"), 4000, 16000);
	const since = integer(params.get("since"), 0, Number.MAX_SAFE_INTEGER);
	const topic = params.get("topic");
	if (
		[...params.keys()].some((key) => !["since", "topic", "budget"].includes(key)) ||
		budget === null ||
		budget < 100 ||
		since === null ||
		(topic !== null && !validTopic(topic))
	)
		return yield* new KernelError({ code: "query_invalid" });
	const topics = yield* Topics;
	const messages = yield* Messages;
	const detail = yield* topics.detail(who, topic ?? "");
	if (since > detail.cursor) return yield* new KernelError({ code: "query_invalid" });
	const recent = yield* messages.list({
		since: 0,
		limit: 201,
		newest: true,
		...(topic ? { topic } : {}),
		recursive: true,
	});
	const inbox = yield* topics.inbox(who, yield* topics.cursor(who), 21, "agent", 2000);
	const changes = yield* activity(since, topic);
	const cap = budget * 4;
	const footer = "\nTruncated: yes. Approximate budget: 4 UTF-16 code units/token.\n";
	let text = `# ${topic ?? "comms"}\n`;
	let truncated =
		changes.truncated ||
		recent.items.length > 200 ||
		inbox.items.length > 20 ||
		inbox.scan_truncated ||
		detail.subtopics.length > 20;
	const append = (section: string, maximum = cap) => {
		const available = Math.max(0, Math.min(maximum, cap - footer.length - text.length));
		if (section.length <= available) text += section;
		else {
			truncated = true;
			if (available > 24) text += section.slice(0, available - 16) + "\n[…omitted…]\n";
		}
	};
	if (detail.index !== null) append(`\n## README\n\n${detail.index}\n`, Math.floor(cap / 3));
	append(
		`\nUnread in topic tree: ${detail.unread}. Inbox (agent mode): ${Math.min(20, inbox.items.length)}${inbox.items.length > 20 || inbox.scan_truncated ? "+" : ""}.\n`,
	);
	if (Object.keys(detail.meta).length)
		append(
			`\nMeta: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(detail.meta)}\n`,
			Math.floor(cap / 8),
		);
	append(changes.text, Math.floor(cap / 4));
	const items = recent.items.slice(0, 200);
	const priority = (message: (typeof items)[number]) =>
		message.meta.pinned === true
			? 2
			: (message.tags.includes("blocked") || message.tags.includes("question")) &&
				  !message.tags.includes("done") &&
				  message.meta.status !== "done" &&
				  message.meta.status !== "answered"
				? 1
				: 0;
	const chosen = [...items].sort((a, b) => priority(b) - priority(a) || b.seq - a.seq);
	for (const message of chosen.filter((message) => priority(message) > 0))
		append(
			`\n## #${message.seq} · ${message.topic} · ${message.agent}${message.meta.pinned === true ? " · pinned" : " · open"}\n\n${message.body}\n`,
		);
	for (const child of detail.subtopics.slice(0, 20)) {
		const last = items.find((message) => message.topic === child.path || message.topic.startsWith(`${child.path}/`));
		append(
			`\n- ${child.path} · status: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(child.meta.status ?? "unset")} · unread: ${child.unread} · last #${last?.seq ?? child.last_seq}${last ? `: ${last.body.replace(/\s+/g, " ").slice(0, 160)}` : " (outside message window)"}\n`,
		);
	}
	for (const file of detail.pages)
		append(`\nPage: /p/${[...(topic?.split("/") ?? []), file].map(encodeURIComponent).join("/")}\n`);
	append(`\n## Changes since #${since}\n`);
	for (const message of chosen.filter((message) => priority(message) === 0 && message.seq > since))
		append(`\n### #${message.seq} · ${message.topic} · ${message.agent}\n\n${message.body}\n`);
	if (inbox.items.length) {
		append("\n## Your unread inbox (agent mode)\n");
		for (const message of inbox.items.slice(0, 20))
			append(
				`\n- #${message.seq} · ${message.topic} · ${message.agent}: ${message.body.replace(/\s+/g, " ").slice(0, 160)}\n`,
			);
	}
	append(
		`\nSources: latest 200 subtree messages, 20 subtopics and 20 inbox matches (at most 2000 scanned messages). Event sections are separate boot-log reads, not a shared snapshot with messages. Full events: /api/events?since=${since}&types=message.*,ext.failed,ext.error,generation.*\n`,
	);
	text += `\nTruncated: ${truncated ? "yes" : "no"}. Approximate budget: 4 UTF-16 code units/token.\n`;
	return HttpServerResponse.text(text, {
		contentType: "text/markdown; charset=utf-8",
		headers: { "cache-control": "no-store" },
	});
});
