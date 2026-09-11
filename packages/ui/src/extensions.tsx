import { RecoveryControls } from "./recovery-controls.tsx";
import { BoardLayout } from "./board-layout.tsx";
import { DateTime } from "effect";

import { useLoad } from "./use-load.ts";
import { useBoardClient } from "./board-client.tsx";

export function Extensions() {
	const client = useBoardClient();
	const { value: items, error, loading, reload: reloadExtensions } = useLoad(client.extensions);
	const { value: lock, error: lockError, reload: reloadLock } = useLoad(client.lock);
	const reload = () => {
		reloadExtensions();
		reloadLock();
	};
	return (
		<BoardLayout
			navigation={
				<>
					<a
						className="my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal"
						href="/"
					>
						All topics
					</a>
					<a
						className="my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal bg-[#e3ebdd] font-semibold text-[#36532e]"
						aria-current="page"
						href="/ext"
					>
						Extensions
					</a>
				</>
			}
		>
			<header className="mb-[30px] flex items-start justify-between gap-4 min-[651px]:mb-10 min-[651px]:items-center [&_p]:mt-2.5 [&_p]:text-xs [&_p]:leading-[1.6] [&_p]:text-[#7b8176] min-[651px]:[&_p]:text-[13px]">
				<div>
					<nav className="mb-2.5 text-[11px] wrap-anywhere text-[#858b80] min-[651px]:mb-4" aria-label="Breadcrumb">
						<a href="/">Board</a> / Extensions
					</nav>
					<h1 className="text-[26px] leading-[1.2] font-[650] tracking-[-0.9px] wrap-anywhere min-[651px]:text-[30px]">
						Extensions
					</h1>
					<p>What is loaded in the current generation. Updates with server events.</p>
				</div>
				<button
					type="button"
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] disabled:cursor-default disabled:opacity-50 shrink-0 bg-transparent text-[12px] text-[#68705f]"
					onClick={reload}
					disabled={loading}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{error && (
				<div
					className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5 "
					role="alert"
				>
					<p>{error.message}</p>
					{error.status === 401 && <a href="/auth/login">Sign in with a passkey</a>}
				</div>
			)}
			{loading && items === undefined && !error && (
				<p
					className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]"
					role="status"
				>
					Loading extensions…
				</p>
			)}
			{items !== undefined && !error && (
				<section aria-label="Loaded extensions">
					{items.length === 0 && (
						<p className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]">
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
				<RecoveryControls lock={lockError ? undefined : lock} refresh={reload} />
				<p>Source edits and recovery use the bootloader. Source and diagnostic views require source access.</p>
				<nav
					className="mt-5 flex flex-wrap gap-x-6 gap-y-3 [&>a]:text-xs [&>a]:underline [&>a]:underline-offset-[3px]"
					aria-label="Extension tools"
				>
					<a href="/_boot/recovery">Immutable recovery ↗</a>
					<a href="/_boot">Recovery instructions ↗</a>
					<a href="/_boot/status">Boot diagnostics ↗</a>
					<a href="/api/events?types=ext.*&since=0&limit=100">Extension events ↗</a>
					<a href="/p/docs/extensions.md">Extension guide ↗</a>
				</nav>
			</section>
		</BoardLayout>
	);
}
