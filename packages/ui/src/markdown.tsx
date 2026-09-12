import { Marked } from "marked";
import { createElement, useMemo, type ReactNode } from "react";
import { Link, spaHref } from "./router.tsx";

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
const linkClass = "text-primary underline underline-offset-[3px] hover:text-primary-hover";
const referenceText = (text: string): ReactNode =>
	text.split(/((?<![\w/#])#[1-9][0-9]*(?![\w]))/u).map((part, index) => {
		const seq = /^#[1-9][0-9]*$/.test(part) ? Number(part.slice(1)) : 0;
		return Number.isSafeInteger(seq) && seq > 0 ? (
			<Link className={linkClass} key={index} href={messageHref(seq)}>
				{part}
			</Link>
		) : (
			part
		);
	});

// Static classes for the renderer's allowlisted elements; no typography plugin is needed.
const markdownClasses: Readonly<Record<string, string>> = {
	p: "my-2.5",
	h1: "mt-4 mb-2 text-base leading-snug font-semibold tracking-normal",
	h2: "mt-4 mb-2 text-base font-semibold tracking-normal",
	h3: "mt-4 mb-2 text-base font-semibold tracking-normal",
	h4: "mt-4 mb-2 text-base font-semibold tracking-normal",
	h5: "mt-4 mb-2 text-base font-semibold tracking-normal",
	h6: "mt-4 mb-2 text-base font-semibold tracking-normal",
	ul: "my-2.5 list-disc pl-6",
	ol: "my-2.5 list-decimal pl-6",
	blockquote: "my-2.5 border-l-[3px] border-accent pl-3.5 text-muted-foreground",
	code: "rounded-sm bg-tag-surface px-1 py-0.5 text-xs",
	pre: "my-2.5 overflow-x-auto rounded-md bg-tag-surface p-3 whitespace-pre [&_code]:p-0",
	table: "my-2.5 block border-collapse overflow-x-auto",
	th: "border border-input px-2.5 py-1.5 text-left",
	td: "border border-input px-2.5 py-1.5 text-left",
	hr: "my-4 border-0 border-t border-input",
};

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
			if (tag === "a") {
				const href = safeHref(node.getAttribute("href") ?? "", base);
				if (href !== undefined && spaHref(href) !== null)
					return (
						<Link className={linkClass} key={key} href={href}>
							{children}
						</Link>
					);
				return (
					<a className={linkClass} key={key} href={href} rel="noreferrer">
						{children}
					</a>
				);
			}
			if (tag === "input")
				return (
					<input
						className="mr-1.5 accent-primary"
						key={key}
						type="checkbox"
						checked={node.hasAttribute("checked")}
						disabled
						aria-label="Task status"
					/>
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
				{
					key,
					className: markdownClasses[tag],
					...(tag === "ol" ? { start: Number(node.getAttribute("start") ?? 1) } : {}),
				},
				...children,
			);
		};
		return Array.from(document.body.childNodes, (node, index) => render(node, index));
	}, [body, base]);
	return (
		<div className="text-[13px] leading-[1.85] wrap-anywhere [&>:first-child]:mt-0 [&>:last-child]:mb-0">{content}</div>
	);
}
