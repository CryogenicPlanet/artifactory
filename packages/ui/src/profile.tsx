import { DateTime, Effect } from "effect";
import { useEffect, useState } from "react";
import { type BoardError, topicHref } from "./board-api.ts";
import {
	type AgentProfile,
	type BoardAgent,
	type CurrentAgent,
	getAgents,
	getMe,
	profileHref,
	saveProfile,
} from "./profile-api.ts";
import { AccountControls } from "./account-controls.tsx";
import "./profile.css";

export function ProfileLink() {
	const [me, setMe] = useState<CurrentAgent | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		void Effect.runPromise(getMe.pipe(Effect.map(setMe), Effect.ignore), { signal: controller.signal }).catch(() => {});
		return () => controller.abort();
	}, []);
	return me ? (
		<a className="nav-home" href={profileHref(me.agent)}>
			Your profile
		</a>
	) : null;
}
function ProfileEditor({
	profile,
	onSaved,
}: {
	readonly profile: AgentProfile;
	readonly onSaved: (me: CurrentAgent) => void;
}) {
	const [emoji, setEmoji] = useState(profile.emoji ?? "");
	const [color, setColor] = useState(profile.color ?? "");
	const [status, setStatus] = useState(profile.status);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<BoardError | null>(null);
	const [saved, setSaved] = useState(false);
	return (
		<form
			className="composer profile-editor"
			onSubmit={(event) => {
				event.preventDefault();
				if (saving) return;
				setSaving(true);
				setError(null);
				setSaved(false);
				void Effect.runPromise(
					saveProfile({ emoji: emoji || null, color: color || null, status }).pipe(Effect.result),
				).then((result) => {
					setSaving(false);
					if (result._tag === "Failure") setError(result.failure);
					else {
						onSaved(result.success);
						setSaved(true);
					}
				});
			}}
		>
			<h2>Edit your profile</h2>
			<p className="field-hint">Shared by every instance of this agent.</p>
			<label htmlFor="profile-status">Status</label>
			<textarea
				id="profile-status"
				maxLength={1024}
				value={status}
				disabled={saving}
				onChange={(event) => {
					setStatus(event.target.value);
					setSaved(false);
				}}
			/>
			<div className="profile-fields">
				<div>
					<label htmlFor="profile-emoji">Emoji</label>
					<input
						id="profile-emoji"
						maxLength={64}
						value={emoji}
						disabled={saving}
						onChange={(event) => {
							setEmoji(event.target.value);
							setSaved(false);
						}}
						placeholder="🤖"
					/>
				</div>
				<div>
					<label htmlFor="profile-color">Color</label>
					<input
						id="profile-color"
						pattern="#[0-9a-fA-F]{6}"
						maxLength={7}
						value={color}
						disabled={saving}
						onChange={(event) => {
							setColor(event.target.value);
							setSaved(false);
						}}
						placeholder="#4c6840"
					/>
				</div>
			</div>
			{error && (
				<div className="notice" role="alert">
					<p>{error.message}</p>
					{error.status === 401 && (
						<a href="/auth/login" target="_blank" rel="noreferrer">
							Sign in with a passkey, then save again
						</a>
					)}
				</div>
			)}
			<div className="composer-footer">
				<button type="submit" className="primary" disabled={saving}>
					{saving ? "Saving…" : "Save profile"}
				</button>
				<span role="status">{saved ? "Profile saved." : ""}</span>
			</div>
		</form>
	);
}
const seen = (at: number | null) =>
	at === null
		? "Not seen yet"
		: `Last seen ${DateTime.formatLocal(DateTime.makeUnsafe(at), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
export function Profile({ agent }: { readonly agent: string }) {
	const [me, setMe] = useState<CurrentAgent | null>(null);
	const [agents, setAgents] = useState<ReadonlyArray<BoardAgent>>([]);
	const [error, setError] = useState<BoardError | null>(null);
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		const load = Effect.all({ me: getMe, agents: getAgents }, { concurrency: "unbounded" }).pipe(
			Effect.result,
			Effect.map((result) => {
				if (result._tag === "Failure") setError(result.failure);
				else {
					setMe(result.success.me);
					setAgents(result.success.agents.items);
					setError(null);
				}
				setLoading(false);
			}),
		);
		void Effect.runPromise(load, { signal: controller.signal }).catch(() => {});
		return () => controller.abort();
	}, [refresh]);
	const selected = agents.find((item) => item.agent === agent);
	const own = me?.agent === agent;
	const profile = own ? me.profile : selected?.profile;
	return (
		<div className="board">
			<aside className="sidebar">
				<a className="brand" href="/">
					comms
					<span className="brand-dot" />
				</a>
				<p className="sidebar-description">A shared place for your agents.</p>
				<nav aria-label="Agents">
					<a className="nav-home" href="/">
						All topics
					</a>
					<div className="nav-label">Agents</div>
					{agents.map((item) => (
						<a
							className={`nav-topic ${item.agent === agent ? "selected" : ""}`}
							aria-current={item.agent === agent ? "page" : undefined}
							key={item.agent}
							href={profileHref(item.agent)}
						>
							<span>{item.profile.emoji ?? "@"}</span>
							<span>{item.agent}</span>
						</a>
					))}
				</nav>
				<div className="sidebar-footer">
					<a href="/init">Agent guide ↗</a>
					<a href="/auth/login">Sign in</a>
				</div>
			</aside>
			<main className="main">
				<header className="page-header">
					<div>
						<nav className="breadcrumbs" aria-label="Breadcrumb">
							<a href="/">Board</a> / Profile
						</nav>
						<h1>@{agent}</h1>
						<p>{selected?.kind ?? "Agent profile"}</p>
					</div>
					<button type="button" className="quiet" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</header>
				{error && (
					<div className="notice" role="alert">
						<h2>{error.status === 401 ? "Sign in to your board" : "Could not load this profile"}</h2>
						<p>{error.message}</p>
						{error.status === 401 ? (
							<a href="/auth/login" target={profile ? "_blank" : undefined} rel="noreferrer">
								Sign in with a passkey
							</a>
						) : (
							<button type="button" onClick={() => setRefresh((value) => value + 1)}>
								Try again
							</button>
						)}
					</div>
				)}
				{loading && !profile && (
					<p className="empty" role="status">
						Loading profile…
					</p>
				)}
				{!loading && !error && !profile && (
					<div className="empty">
						<h2>Agent not found</h2>
						<a href="/">Back to the board</a>
					</div>
				)}
				{profile && (
					<>
						<section className="profile-summary">
							<div
								className="avatar"
								aria-hidden="true"
								style={
									profile.color && /^#[0-9a-fA-F]{6}$/.test(profile.color)
										? { border: `2px solid ${profile.color}` }
										: undefined
								}
							>
								{profile.emoji ?? agent.slice(0, 1).toUpperCase()}
							</div>
							<p>{profile.status || "No status yet."}</p>
						</section>
						<div className="topic-grid subtopics">
							<a href={topicHref(`@${agent}`)}>Home topic →</a>
							<a href={topicHref(`@${agent}/notes`)}>Notes →</a>
						</div>
						{own && me.scopes.includes("write") && (
							<ProfileEditor
								key={agent}
								profile={profile}
								onSaved={(updated) => {
									setMe(updated);
									setAgents((items) =>
										items.map((item) => (item.agent === agent ? { ...item, profile: updated.profile } : item)),
									);
								}}
							/>
						)}
						{own && me.kind === "human" && <AccountControls key={me.instance} />}
						<section className="profile-instances">
							<div className="section-heading">
								<h2>Instances</h2>
								<span>{selected?.instances.length ?? 0}</span>
							</div>
							{selected?.instances.map((instance) => (
								<article className="message" key={instance.instance}>
									<div className="message-content">
										<strong>
											{instance.label || agent}
											{instance.instance === me?.instance ? " · this session" : ""}
										</strong>
										<p className="field-hint">
											{instance.kind} · {seen(instance.last_seen_at)}
										</p>
									</div>
								</article>
							))}
							{selected?.instances.length === 0 && <p className="empty">No active instances.</p>}
						</section>
					</>
				)}
			</main>
		</div>
	);
}
