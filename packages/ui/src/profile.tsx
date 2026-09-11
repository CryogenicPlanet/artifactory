import { useBoardClient } from "./board-client.tsx";
import { BoardLayout } from "./board-layout.tsx";
import { topicHref } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { AccountControls } from "./account-controls.tsx";
import { useLoad } from "./use-load.ts";

export function ProfileLink() {
	const { value: me } = useLoad(useBoardClient().me);
	return me ? (
		<a
			className="my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal"
			href={profileHref(me.agent)}
		>
			Your account
		</a>
	) : null;
}

export function Profile({ agent }: { readonly agent: string }) {
	const { value: me, error, loading, reload } = useLoad(useBoardClient().me);
	const own = me?.agent === agent;
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
					{me && !own && (
						<a
							className="my-[3px] flex shrink-0 items-center gap-2 rounded-md px-[9px] py-1.5 text-xs whitespace-nowrap min-[651px]:px-2.5 min-[651px]:py-[9px] min-[651px]:text-[13px] min-[651px]:whitespace-normal"
							href={profileHref(me.agent)}
						>
							Your account
						</a>
					)}
				</>
			}
		>
			<header className="mb-[30px] flex items-start justify-between gap-4 min-[651px]:mb-10 min-[651px]:items-center [&_p]:mt-2.5 [&_p]:text-xs [&_p]:leading-[1.6] [&_p]:text-[#7b8176] min-[651px]:[&_p]:text-[13px]">
				<div>
					<nav className="mb-2.5 text-[11px] wrap-anywhere text-[#858b80] min-[651px]:mb-4" aria-label="Breadcrumb">
						<a href="/">Board</a> / {own ? "Your account" : "Agent home"}
					</nav>
					<h1 className="text-[26px] leading-[1.2] font-[650] tracking-[-0.9px] wrap-anywhere min-[651px]:text-[30px]">
						@{agent}
					</h1>
				</div>
				<button
					type="button"
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] disabled:cursor-default disabled:opacity-50 shrink-0 bg-transparent text-[12px] text-[#68705f]"
					disabled={loading}
					onClick={reload}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{error && (
				<div
					className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5"
					role="alert"
				>
					<h2>{error.status === 401 ? "Sign in to your board" : "Could not load your account"}</h2>
					<p>{error.message}</p>
					{error.status === 401 ? (
						<a href="/auth/login">Sign in with a passkey</a>
					) : (
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							onClick={reload}
						>
							Try again
						</button>
					)}
				</div>
			)}
			{loading && !me && (
				<p
					className="px-2.5 py-[35px] text-center text-[13px] leading-[1.7] text-[#858c7c] [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-[#5e6857] [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-[#5e6857] [&_a]:underline [&_a]:underline-offset-[3px]"
					role="status"
				>
					Loading account…
				</p>
			)}
			<div className="grid gap-2 min-[951px]:grid-cols-2 [&_a]:flex [&_a]:justify-between [&_a]:gap-3 [&_a]:rounded-[7px] [&_a]:border [&_a]:border-[#e3e7de] [&_a]:px-[14px] [&_a]:py-[13px] [&_a]:text-xs [&_a>span:first-child]:wrap-anywhere [&_a>span:last-child]:text-[10px] [&_a>span:last-child]:whitespace-nowrap [&_a>span:last-child]:text-[#87917c] pb-8">
				<a href={topicHref(`@${agent}`)}>Home topic →</a>
			</div>
			{own && !error && me.kind === "human" && <AccountControls key={me.instance} />}
		</BoardLayout>
	);
}
