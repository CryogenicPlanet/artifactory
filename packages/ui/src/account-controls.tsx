import { useLoad } from "./use-load.ts";
import { Effect } from "effect";
import { useState } from "react";
import { type BoardError } from "./board-api.ts";
import { getPasskeys } from "./account-api.ts";
import { addPasskey, deletePasskey } from "./account-passkeys.ts";
import { AccountSettings } from "./account-settings.tsx";
import { AccountTokens } from "./account-tokens.tsx";

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
				<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
					<h2 id="account-passkeys-heading">Your passkeys</h2>
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="button"
						disabled={busy}
						onClick={() => {
							setError(null);
							reload();
						}}
					>
						Refresh passkeys
					</button>
				</div>
				{passkeys?.items.map((passkey) => (
					<article
						className="flex items-center justify-between gap-3 border-b border-[#e3e8df] py-4 [&>div]:min-w-0 [&>div]:wrap-anywhere [&_strong]:min-w-0 [&_strong]:wrap-anywhere [&_p]:my-[5px] [&_p]:text-[#737d6d] [&_small]:wrap-anywhere [&_small]:text-[#939b89] [&_button]:max-w-[48%] [&_button]:shrink-0 [&_button]:wrap-anywhere"
						key={passkey.id}
					>
						<strong>{passkey.label}</strong>
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							disabled={busy || !passkeys.can_delete}
							onClick={() => run(deletePasskey(passkey.id), "Passkey removed.")}
						>
							Remove {passkey.label}
						</button>
					</article>
				))}
				{passkeys && !passkeys.can_delete && (
					<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
						Keep at least one passkey so you can sign in.
					</p>
				)}
				<form
					className="rounded-[10px] border border-[#dfe5d8] bg-white p-[17px] min-[651px]:p-[22px] mt-[18px] [&_h3]:text-sm [&_fieldset]:mb-4 [&_fieldset]:min-w-0 [&_button]:mt-[14px]"
					onSubmit={(event) => {
						event.preventDefault();
						run(addPasskey(label.trim()), "Passkey added.");
					}}
				>
					<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="passkey-label">
						New passkey label
					</label>
					<input
						className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
						id="passkey-label"
						value={label}
						maxLength={128}
						required
						disabled={busy}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="Backup security key"
					/>
					<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
						First create the new passkey, then confirm using one already registered to this board.
					</p>
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="submit"
						disabled={busy || !label.trim()}
					>
						Add passkey
					</button>
				</form>
				<p role="status">{message}</p>
				{(error ?? loadError) && (
					<div
						className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5"
						role="alert"
					>
						{(error ?? loadError)?.message}
						{(error ?? loadError)?.status === 401 && (
							<p>
								<a href="/auth/login">Sign in again</a>
							</p>
						)}
					</div>
				)}
			</section>
			<AccountTokens />
			<AccountSettings />
		</div>
	);
}
