import {
	useEffect,
	useRef,
	useSyncExternalStore,
	type AnchorHTMLAttributes,
	type MouseEvent as ReactMouseEvent,
} from "react";

const NAVIGATE = "comms:navigate";

/** SPA routes render in this app; everything else (/auth, /_boot, /p, /api, /setup, /init) is a server page. */
const isSpaPath = (pathname: string) =>
	pathname === "/" ||
	pathname === "/ext" ||
	pathname.startsWith("/t/") ||
	/^\/@[a-z0-9][a-z0-9._-]{0,63}$/.test(pathname);

/** Same-origin SPA href (path + search + hash), or null when the link must load from the server. */
export const spaHref = (href: string): string | null => {
	try {
		const url = new URL(href, window.location.origin);
		if (url.origin !== window.location.origin || !isSpaPath(url.pathname)) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
};

export const navigate = (href: string) => {
	const url = new URL(href, window.location.origin);
	if (url.href === window.location.href) return;
	window.history.pushState(null, "", url.href);
	window.dispatchEvent(new Event(NAVIGATE));
};

const subscribe = (onChange: () => void) => {
	window.addEventListener("popstate", onChange);
	window.addEventListener(NAVIGATE, onChange);
	return () => {
		window.removeEventListener("popstate", onChange);
		window.removeEventListener(NAVIGATE, onChange);
	};
};

const snapshot = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

export type Location = { readonly pathname: string; readonly search: string; readonly hash: string };

export const useLocation = (): Location => {
	const raw = useSyncExternalStore(subscribe, snapshot);
	const hashAt = raw.indexOf("#");
	const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
	const searchAt = beforeHash.indexOf("?");
	return {
		pathname: searchAt === -1 ? beforeHash : beforeHash.slice(0, searchAt),
		search: searchAt === -1 ? "" : beforeHash.slice(searchAt),
		hash: hashAt === -1 ? "" : raw.slice(hashAt),
	};
};

/**
 * Scrolls to the top after client navigation, or to a hash target once it exists.
 * Back/forward keeps the browser's own scroll restoration.
 */
export const useScrollOnNavigate = () => {
	const location = useLocation();
	const cause = useRef<"push" | "pop">("push");
	useEffect(() => {
		const push = () => {
			cause.current = "push";
		};
		const pop = () => {
			cause.current = "pop";
		};
		window.addEventListener(NAVIGATE, push);
		window.addEventListener("popstate", pop);
		return () => {
			window.removeEventListener(NAVIGATE, push);
			window.removeEventListener("popstate", pop);
		};
	}, []);
	useEffect(() => {
		if (cause.current === "pop") return;
		if (!location.hash) {
			window.scrollTo(0, 0);
			return;
		}
		const id = location.hash.slice(1);
		let attempts = 0;
		let frame = 0;
		const tick = () => {
			const target = document.getElementById(id);
			if (target) {
				target.scrollIntoView();
				return;
			}
			if (++attempts < 30) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [location]);
};

const modified = (event: ReactMouseEvent) =>
	event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;

/** Renders a plain anchor for server routes and external URLs; SPA routes navigate without a reload. */
export function Link({
	href,
	onClick,
	target,
	...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }) {
	const internal = spaHref(href);
	if (internal === null) return <a href={href} target={target} onClick={onClick} {...props} />;
	return (
		<a
			href={internal}
			target={target}
			onClick={(event) => {
				onClick?.(event);
				if (event.defaultPrevented || target !== undefined || modified(event)) return;
				event.preventDefault();
				navigate(internal);
			}}
			{...props}
		/>
	);
}
