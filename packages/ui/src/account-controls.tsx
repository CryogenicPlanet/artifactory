import { Effect } from "effect";
import { useEffect, useState } from "react";
import { type BoardError } from "./board-api.ts";
import { getPasskeys, type PasskeyList } from "./account-api.ts";
import { addPasskey, deletePasskey } from "./account-passkeys.ts";
import { AccountTokens } from "./account-tokens.tsx";
import "./account-controls.css";

export function AccountControls() {
	const [passkeys, setPasskeys] = useState<PasskeyList | null>(null);
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [message, setMessage] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		void Effect.runPromise(getPasskeys.pipe(Effect.result), { signal: controller.signal })
			.then((result) => {
				if (result._tag === "Success") setPasskeys(result.success);
				else setError(result.failure);
			})
			.catch(() => {});
		return () => controller.abort();
	}, [refresh]);
	const run = (operation: Effect.Effect<void, BoardError>, success: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setMessage("Waiting for your passkey…");
		void Effect.runPromise(operation.pipe(Effect.result)).then((result) => {
			setBusy(false);
			setRefresh((value) => value + 1);
			if (result._tag === "Failure") {
				setError(result.failure);
				setMessage("");
			} else {
				setMessage(success);
				setLabel("");
			}
		});
	};
	return (
		<div className="account-controls">
			<section className="account-section" aria-labelledby="account-passkeys-heading">
				<div className="section-heading">
					<h2 id="account-passkeys-heading">Your passkeys</h2>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							setError(null);
							setRefresh((value) => value + 1);
						}}
					>
						Refresh passkeys
					</button>
				</div>
				{passkeys?.items.map((passkey) => (
					<article className="account-row" key={passkey.id}>
						<strong>{passkey.label}</strong>
						<button
							type="button"
							disabled={busy || !passkeys.can_delete}
							onClick={() => run(deletePasskey(passkey.id), "Passkey removed.")}
						>
							Remove {passkey.label}
						</button>
					</article>
				))}
				{passkeys && !passkeys.can_delete && (
					<p className="field-hint">Keep at least one passkey so you can sign in.</p>
				)}
				<form
					className="composer account-form"
					onSubmit={(event) => {
						event.preventDefault();
						run(addPasskey(label.trim()), "Passkey added.");
					}}
				>
					<label htmlFor="passkey-label">New passkey label</label>
					<input
						id="passkey-label"
						value={label}
						maxLength={128}
						required
						disabled={busy}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="Backup security key"
					/>
					<p className="field-hint">
						First create the new passkey, then confirm using one already registered to this board.
					</p>
					<button type="submit" disabled={busy || !label.trim()}>
						Add passkey
					</button>
				</form>
				<p role="status">{message}</p>
				{error && (
					<div className="notice" role="alert">
						{error.message}
						{error.status === 401 && (
							<p>
								<a href="/auth/login">Sign in again</a>
							</p>
						)}
					</div>
				)}
			</section>
			<AccountTokens />
		</div>
	);
}
