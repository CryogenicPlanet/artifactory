import { Marked } from "marked";
import highlight from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";

export const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
export const pageHref = (name: string) => `/p/${name.split("/").map(encodeURIComponent).join("/")}`;
export const pageDocument = (
	name: string,
	body: string,
	options: { title?: string; raw?: string; rawHref?: string; assets?: string } = {},
) => {
	let current = "";
	const crumbs = [`<a href="/">chirp</a>`, `<a href="/p/">pages</a>`];
	for (const part of name.split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		crumbs.push(`<a href="${escapeHtml(pageHref(current))}">${escapeHtml(part)}</a>`);
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title ?? (name || "Pages"))}</title>
<style>body{margin:0;background:#fafafa;color:#222;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:820px;margin:0 auto;padding:4vh 1.2rem 12vh}nav{display:flex;flex-wrap:wrap;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;font-size:13px}a{color:#176c52}pre{overflow:auto}img{max-width:100%}.markdown-body{background:transparent}.listing{padding-left:1.2rem}</style>${options.assets ?? ""}</head><body><div class="wrap"><nav><span>${crumbs.join(" / ")}</span>${options.rawHref || options.raw ? `<a href="${escapeHtml(options.rawHref ?? `${pageHref(options.raw ?? "")}?raw=1`)}">raw</a>` : ""}</nav><article class="markdown-body">${body}</article></div></body></html>`;
};

/** Each Pages instance owns its parser and highlighter; never change package defaults. */
export const pageMarkdown = () => {
	const highlighter = highlight.newInstance();
	for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, xml, css, sql, yaml }))
		highlighter.registerLanguage(name, language);
	const parser = new Marked({
		gfm: true,
		breaks: false,
		renderer: {
			code({ text, lang }) {
				const language = lang?.split(/\s+/)[0] ?? "";
				if (language === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
				const rendered =
					language && highlighter.getLanguage(language)
						? highlighter.highlight(text, { language }).value
						: escapeHtml(text);
				return `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${rendered}</code></pre>`;
			},
		},
	});
	return (text: string, name: string, options: { rawHref?: string } = {}) => {
		const matched = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		const frontmatter = matched?.[1] ?? "";
		const body = parser.parse(matched ? text.slice(matched[0].length) : text, { async: false });
		const tailwind = /<!--\s*tailwind\s*-->/i.test(text) || /^tailwind:[ \t]*true[ \t]*$/m.test(frontmatter);
		const assets = `<link rel="stylesheet" href="/page-assets/markdown.css">${body.includes('class="hljs') ? '<link rel="stylesheet" href="/page-assets/highlight.css">' : ""}${body.includes('class="mermaid"') ? '<script defer src="/page-assets/mermaid.js"></script><script defer src="/page-assets/mermaid-init.js"></script>' : ""}${tailwind ? '<style type="text/tailwindcss">@layer theme, utilities; @import "tailwindcss/theme" layer(theme); @import "tailwindcss/utilities" layer(utilities);</style><script defer src="/page-assets/tailwind.js"></script>' : ""}`;
		return pageDocument(name, body, { title: text.match(/^#\s+(.+)$/m)?.[1] ?? name, raw: name, ...options, assets });
	};
};
