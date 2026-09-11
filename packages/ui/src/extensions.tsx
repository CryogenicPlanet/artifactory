import { BoardLayout } from "./board-layout.tsx";
import { DateTime, Effect } from "effect";

import { useLoad } from "./use-load.ts";
import { getEditLock, getExtensions } from "./extension-api.ts";

const extensionRequests = Effect.all(
	{ extensions: getExtensions.pipe(Effect.result), lock: getEditLock.pipe(Effect.result) },
	{ concurrency: "unbounded" },
);

export function Extensions() {
	const { value, loading, reload } = useLoad(extensionRequests, true);
	const items = value?.extensions._tag === "Success" ? value.extensions.success : undefined;
	const error = value?.extensions._tag === "Failure" ? value.extensions.failure : null;
	const lock = value?.lock._tag === "Success" ? value.lock.success : undefined;
	const lockError = value?.lock._tag === "Failure" ? value.lock.failure : null;
	return (
		<BoardLayout
			navigation={
				<>
					<a className="nav-home" href="/">
						All topics
					</a>
					<a className="nav-home bg-[#e3ebdd] font-semibold text-[#36532e]" aria-current="page" href="/ext">
						Extensions
					</a>
				</>
			}
		>
			<header className="page-header">
				<div>
					<nav className="mb-2.5 text-[11px] wrap-anywhere text-[#858b80] min-[651px]:mb-4" aria-label="Breadcrumb">
						<a href="/">Board</a> / Extensions
					</nav>
					<h1>Extensions</h1>
					<p>What is loaded in the current generation. Updates every 10s.</p>
				</div>
				<button type="button" className="quiet" onClick={reload} disabled={loading}>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{error && (
				<div className="notice error" role="alert">
					<p>{error.message}</p>
					{error.status === 401 && <a href="/auth/login">Sign in with a passkey</a>}
				</div>
			)}
			{loading && items === undefined && !error && (
				<p className="empty" role="status">
					Loading extensions…
				</p>
			)}
			{items !== undefined && !error && (
				<section aria-label="Loaded extensions">
					{items.length === 0 && (
						<p className="empty">
							No extensions are installed. <a href="/p/docs/extensions.md">Read the extension guide</a> to add one.
						</p>
					)}
					{items.map((item) => (
						<article
							className="border-t border-[#e3e8df] py-6 text-[13px] wrap-anywhere [&>header]:flex [&>header]:flex-wrap [&>header]:items-center [&>header]:gap-3 [&_h2]:text-[15px] [&_h2]:font-[650]"
							key={item.name}
						>
							<header>
								<h2>{item.name}</h2>
								<span
									data-status={item.status}
									className="rounded-[5px] bg-[#e9eee3] px-2 py-[3px] text-[11px] text-[#36532e] data-[status=disabled]:bg-[#faebe6] data-[status=disabled]:text-[#914934]"
								>
									{item.status === "loaded" ? "Loaded" : "Disabled"}
								</span>
								<span className="text-[11px] text-[#737d6d]">{item.load_ms} ms to load</span>
							</header>
							{item.error !== null && (
								<div className="my-4 text-[#914934] [&_summary]:cursor-pointer [&_pre]:text-[11px] [&_pre]:leading-[1.7] [&_pre]:wrap-anywhere [&_pre]:whitespace-pre-wrap">
									<p>{item.error.split("\n", 1)[0]}</p>
									<details>
										<summary>Full error</summary>
										<pre>{item.error}</pre>
									</details>
								</div>
							)}
							{item.registrations.length > 0 && (
								<ul className="my-[18px] list-none p-0 [&>li]:my-3 [&_span]:mt-1 [&_span]:block [&_span]:leading-[1.6] [&_span]:text-[#737d6d]">
									{item.registrations.map((route, index) => (
										<li key={`${route.method}-${route.path}-${index}`}>
											<code>
												{route.method} {route.path}
											</code>
											<span>
												{route.description} · {route.scope} scope
											</span>
										</li>
									))}
								</ul>
							)}
							<a
								className="text-xs underline underline-offset-[3px]"
								href={`/_boot/fs/app/ext/${encodeURIComponent(item.name)}`}
							>
								Read source ↗
							</a>
						</article>
					))}
				</section>
			)}
			<section
				className="mt-[30px] border-t border-[#e3e8df] pt-6 text-[13px] leading-[1.7] wrap-anywhere [&>h2]:text-[15px] [&>h2]:font-[650]"
				aria-labelledby="edit-lock-heading"
			>
				<h2 id="edit-lock-heading">Edit lock</h2>
				{lockError ? (
					<p>{lockError.message}</p>
				) : lock === undefined ? (
					<p>Loading lock status…</p>
				) : lock ? (
					<>
						<p>
							<strong>{lock.agent}</strong> is editing.
							<br />
							<span className="text-[11px] text-[#737d6d]">Instance: {lock.holder_family}</span>
						</p>
						{lock.note && <p>{lock.note}</p>}
						<p>
							{lock.cutover_in_flight
								? "A reload is in progress; the lock is held until it finishes."
								: `Expires ${DateTime.formatLocal(DateTime.makeUnsafe(lock.expires), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`}
							{lock.pending_release && " Release is pending."}
						</p>
					</>
				) : (
					<p>No one holds the edit lock.</p>
				)}
				<p>Source edits and recovery use the bootloader. Source and diagnostic views require source access.</p>
				<nav
					className="mt-5 flex flex-wrap gap-x-6 gap-y-3 [&>a]:text-xs [&>a]:underline [&>a]:underline-offset-[3px]"
					aria-label="Extension tools"
				>
					<a href="/_boot">Recovery instructions ↗</a>
					<a href="/_boot/status">Boot diagnostics ↗</a>
					<a href="/api/events?types=ext.*&since=0&limit=100">Extension events ↗</a>
					<a href="/p/docs/extensions.md">Extension guide ↗</a>
				</nav>
			</section>
		</BoardLayout>
	);
}
