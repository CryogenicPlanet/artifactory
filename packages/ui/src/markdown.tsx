import { Marked } from "marked";
import { createElement, useMemo, type ReactNode } from "react";
import "./markdown.css";

export const messageHref = (seq: number) => `/?message=${seq}#message-${seq}`;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const safeHref = (href: string, base: string) => {
	try {
		const url = new URL(href, new URL(base, window.location.origin));
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
};
const referenceText = (text: string): ReactNode =>
	text.split(/((?<![\w/#])#[1-9][0-9]*(?![\w]))/u).map((part, index) => {
		const seq = /^#[1-9][0-9]*$/.test(part) ? Number(part.slice(1)) : 0;
		return Number.isSafeInteger(seq) && seq > 0 ? (
			<a key={index} href={messageHref(seq)}>
				{part}
			</a>
		) : (
			part
		);
	});

/** Untrusted Markdown becomes React nodes; raw HTML stays text and images require a click. */
export function Markdown({ body, base = "/" }: { readonly body: string; readonly base?: string }) {
	const content = useMemo(() => {
		const parser = new Marked({
			gfm: true,
			breaks: true,
			renderer: {
				html: ({ text }) => escape(text),
				image: ({ href, text }) => `<a href="${escape(safeHref(href, base) ?? "")}">${escape(text || "Image")} ↗</a>`,
			},
		});
		const document = new DOMParser().parseFromString(parser.parse(body, { async: false }), "text/html");
		const render = (node: Node, key: number, references = true): ReactNode => {
			if (node.nodeType === Node.TEXT_NODE)
				return references ? referenceText(node.textContent ?? "") : node.textContent;
			if (!(node instanceof HTMLElement)) return null;
			const tag = node.tagName.toLowerCase();
			const children = Array.from(node.childNodes)
				.filter(
					(child) =>
						!(
							["table", "thead", "tbody", "tr"].includes(tag) &&
							child.nodeType === Node.TEXT_NODE &&
							!child.textContent?.trim()
						),
				)
				.map((child, index) => render(child, index, references && !["code", "pre", "a"].includes(tag)));
			if (tag === "a")
				return (
					<a key={key} href={safeHref(node.getAttribute("href") ?? "", base)} rel="noreferrer">
						{children}
					</a>
				);
			if (tag === "input")
				return (
					<input key={key} type="checkbox" checked={node.hasAttribute("checked")} disabled aria-label="Task status" />
				);
			if (
				![
					"p",
					"strong",
					"em",
					"del",
					"code",
					"pre",
					"blockquote",
					"ul",
					"ol",
					"li",
					"h1",
					"h2",
					"h3",
					"h4",
					"h5",
					"h6",
					"hr",
					"br",
					"table",
					"thead",
					"tbody",
					"tr",
					"th",
					"td",
				].includes(tag)
			)
				return children;
			return createElement(
				tag,
				{ key, ...(tag === "ol" ? { start: Number(node.getAttribute("start") ?? 1) } : {}) },
				...children,
			);
		};
		return Array.from(document.body.childNodes, (node, index) => render(node, index));
	}, [body, base]);
	return <div className="markdown">{content}</div>;
}
