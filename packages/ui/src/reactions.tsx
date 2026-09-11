import { Effect, Random } from "effect";
import { useEffect, useRef, useState } from "react";
import { getReactions, toggleReaction, type MessageReaction } from "./reaction-api.ts";
import "./reactions.css";

export function Reactions({
	message,
	currentInstance,
	disabled = false,
}: {
	readonly message: string;
	readonly currentInstance?: string | null;
	readonly disabled?: boolean;
}) {
	const [snapshot, setSnapshot] = useState<{ readonly items: readonly MessageReaction[]; readonly cursor: number }>({
		items: [],
		cursor: 0,
	});
	const [instance, setInstance] = useState<string | null>(currentInstance ?? null);
	const [needsCheck, setNeedsCheck] = useState(false);
	const [error, setError] = useState("");
	const [authRequired, setAuthRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [sending, setSending] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const inFlight = useRef(false);
	useEffect(() => setInstance(currentInstance ?? null), [currentInstance]);
	useEffect(() => {
		const controller = new AbortController();
		const load = Effect.gen(function* () {
			setLoading(true);
			const result = yield* getReactions(message).pipe(Effect.result);
			if (result._tag === "Success") {
				setSnapshot((previous) => (result.success.cursor >= previous.cursor ? result.success : previous));
				setAuthRequired(false);
			} else {
				setError(result.failure.message);
				setAuthRequired(result.failure.status === 401);
			}
			setLoading(false);
		});
		void Effect.runPromise(load, { signal: controller.signal }).catch(() => {});
		return () => controller.abort();
	}, [message, refresh]);
	const react = (emoji: string) => {
		if (disabled || loading || inFlight.current || needsCheck) return;
		inFlight.current = true;
		setSending(true);
		setError("");
		const send = Effect.gen(function* () {
			const result = yield* toggleReaction({
				message,
				emoji,
				key: (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join("-"),
			}).pipe(Effect.result);
			if (result._tag === "Success") {
				const saved = result.success;
				setInstance(saved.instance);
				setSnapshot((previous) => {
					if (saved.seq < previous.cursor) return previous;
					const others = previous.items.filter(
						(item) => item.instance !== saved.instance || item.emoji !== saved.emoji,
					);
					return {
						cursor: saved.seq,
						items: saved.active ? [...others, { instance: saved.instance, emoji: saved.emoji }] : others,
					};
				});
			} else {
				setError(result.failure.message);
				setAuthRequired(result.failure.status === 401);
				if (result.failure.status === 0 || result.failure.status === 408 || result.failure.status >= 500)
					setNeedsCheck(true);
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					inFlight.current = false;
					setSending(false);
				}),
			),
		);
		Effect.runFork(send);
	};
	const emojis = [...new Set([...snapshot.items.map((item) => item.emoji), "👍", "❤️", "🎉", "👀"])];
	return (
		<div className="reactions" aria-label="Message reactions">
			<div className="reaction-buttons">
				{emojis.map((emoji) => {
					const reactions = snapshot.items.filter((item) => item.emoji === emoji);
					const mine = instance === null ? undefined : reactions.some((item) => item.instance === instance);
					return (
						<button
							key={emoji}
							type="button"
							aria-pressed={mine}
							aria-label={`Toggle ${emoji} reaction${reactions.length ? `, ${reactions.length} reactions` : ""}`}
							disabled={disabled || loading || sending || needsCheck || authRequired}
							onClick={() => react(emoji)}
						>
							{emoji}
							{reactions.length > 0 && <span>{reactions.length}</span>}
						</button>
					);
				})}
				<button
					type="button"
					className="reaction-refresh"
					disabled={loading || sending}
					onClick={() => {
						setError("");
						setRefresh((value) => value + 1);
					}}
				>
					{loading ? "Loading…" : "Refresh reactions"}
				</button>
			</div>
			{sending && <p role="status">Saving reaction…</p>}
			{error && <p role="alert">{error}</p>}
			{authRequired && (
				<a href="/auth/login" target="_blank" rel="noreferrer">
					Sign in in a new tab
				</a>
			)}
			{needsCheck && (
				<p role="alert">
					The toggle may already be saved.{" "}
					<button type="button" onClick={() => window.location.reload()}>
						Reload this page
					</button>{" "}
					and check the reactions before toggling again.
				</p>
			)}
		</div>
	);
}
