import { useLoad } from "./use-load.ts";
import { Effect } from "effect";
import { useState } from "react";
import { type BoardError } from "./board-api.ts";
import { getPasskeys } from "./account-api.ts";
import { addPasskey, deletePasskey } from "./account-passkeys.ts";
import { AccountSettings } from "./account-settings.tsx";
import { AccountOrigins } from "./account-origins.tsx";
import { AccountTokens } from "./account-tokens.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

export function AccountControls() {
	const { value: passkeys, error: loadError, reload } = useLoad(getPasskeys);
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("");
	const [message, setMessage] = useState("");
	const run = (operation: Effect.Effect<void, BoardError>, success: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setMessage("Waiting for your passkey…");
		void Effect.runPromise(operation.pipe(Effect.result)).then((result) => {
			setBusy(false);
			reload();
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
		<div className="mt-9">
			<section className="mt-8 text-[13px]" aria-labelledby="account-passkeys-heading">
				<SectionHeading title={<span id="account-passkeys-heading">Your passkeys</span>}>
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={busy}
						onClick={() => {
							setError(null);
							reload();
						}}
					>
						Refresh passkeys
					</Button>
				</SectionHeading>
				{passkeys?.items.map((passkey) => (
					<article className="flex items-center justify-between gap-3 border-b border-border py-4" key={passkey.id}>
						<span className="min-w-0 wrap-anywhere">
							<strong>{passkey.label}</strong>
							{passkey.rp_id && <span className="text-muted-foreground"> · {passkey.rp_id}</span>}
						</span>
						<Button
							variant="outline"
							size="sm"
							type="button"
							disabled={busy || !passkey.can_delete}
							onClick={() => run(deletePasskey(passkey.id), "Passkey removed.")}
						>
							Remove {passkey.label}
						</Button>
					</article>
				))}
				{passkeys?.items.some((passkey) => !passkey.can_delete) && (
					<p className="mt-1.5 text-[10px] leading-relaxed text-subtle">
						Keep at least one passkey for each configured address so you can sign in.
					</p>
				)}
				<Card className="mt-4">
					<CardContent>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								run(addPasskey(label.trim()), "Passkey added.");
							}}
						>
							<label
								className="mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
								htmlFor="passkey-label"
							>
								New passkey label
							</label>
							<Input
								id="passkey-label"
								value={label}
								maxLength={128}
								required
								disabled={busy}
								onChange={(event) => setLabel(event.target.value)}
								placeholder="Backup security key"
							/>
							<p className="mt-1.5 text-[10px] leading-relaxed text-subtle">
								First create the new passkey, then confirm using one already registered for this address.
							</p>
							<Button className="mt-3.5" variant="outline" size="sm" type="submit" disabled={busy || !label.trim()}>
								Add passkey
							</Button>
						</form>
					</CardContent>
				</Card>
				<p className="mt-3 text-xs text-muted-foreground" role="status">
					{message}
				</p>
				{(error ?? loadError) && (
					<Alert className="mt-4">
						{(error ?? loadError)?.message}
						{(error ?? loadError)?.status === 401 && (
							<p>
								<a href="/auth/login">Sign in again</a>
							</p>
						)}
					</Alert>
				)}
			</section>
			<AccountOrigins />
			<AccountTokens />
			<AccountSettings />
		</div>
	);
}
