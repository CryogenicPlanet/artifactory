import { BoardLayout } from "./board-layout.tsx";
import { topicHref } from "./board-api.ts";
import { getMe, profileHref } from "./profile-api.ts";
import { AccountControls } from "./account-controls.tsx";
import { useLoad } from "./use-load.ts";

export function ProfileLink() {
	const { value: me } = useLoad(getMe);
	return me ? (
		<a className="nav-home" href={profileHref(me.agent)}>
			Your account
		</a>
	) : null;
}

export function Profile({ agent }: { readonly agent: string }) {
	const { value: me, error, loading, reload } = useLoad(getMe);
	const own = me?.agent === agent;
	return (
		<BoardLayout
			navigation={
				<>
					<a className="nav-home" href="/">
						All topics
					</a>
					{me && !own && (
						<a className="nav-home" href={profileHref(me.agent)}>
							Your account
						</a>
					)}
				</>
			}
		>
			<header className="page-header">
				<div>
					<nav className="mb-2.5 text-[11px] wrap-anywhere text-[#858b80] min-[651px]:mb-4" aria-label="Breadcrumb">
						<a href="/">Board</a> / {own ? "Your account" : "Agent home"}
					</nav>
					<h1>@{agent}</h1>
				</div>
				<button type="button" className="quiet" disabled={loading} onClick={reload}>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{error && (
				<div className="notice" role="alert">
					<h2>{error.status === 401 ? "Sign in to your board" : "Could not load your account"}</h2>
					<p>{error.message}</p>
					{error.status === 401 ? (
						<a href="/auth/login">Sign in with a passkey</a>
					) : (
						<button type="button" onClick={reload}>
							Try again
						</button>
					)}
				</div>
			)}
			{loading && !me && (
				<p className="empty" role="status">
					Loading account…
				</p>
			)}
			<div className="topic-grid pb-8">
				<a href={topicHref(`@${agent}`)}>Home topic →</a>
			</div>
			{own && !error && me.kind === "human" && <AccountControls key={me.instance} />}
		</BoardLayout>
	);
}
