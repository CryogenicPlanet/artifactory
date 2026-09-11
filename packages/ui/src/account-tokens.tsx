import { useLoad } from "./use-load.ts";
import { Effect, Schema } from "effect";
import { useMemo, useState } from "react";
import { type BoardError } from "./board-api.ts";
import { accountPost, getFamilies, TokenPair, unreadable } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";

type MintInput = {
	readonly agent: string;
	readonly label: string;
	readonly scopes: readonly string[];
	readonly long_lived: boolean;
};
type PendingMint = { readonly input: MintInput; readonly key: string; readonly proof: string };
export function AccountTokens() {
	const request = useMemo(() => getFamilies(), []);
	const { value: families, error: loadError, reload } = useLoad(request);
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [agent, setAgent] = useState("");
	const [label, setLabel] = useState("");
	const [write, setWrite] = useState(true);
	const [fs, setFs] = useState(false);
	const [long, setLong] = useState(false);
	const [pending, setPending] = useState<PendingMint | null>(null);
	const [pair, setPair] = useState<TokenPair | null>(null);
	const run = (operation: Effect.Effect<void, BoardError>) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		void Effect.runPromise(operation.pipe(Effect.result)).then((result) => {
			setBusy(false);
			if (result._tag === "Failure") setError(result.failure);
		});
	};
	const mint = () => {
		// Browser-only idempotency key; no credential or server runtime is created here.
		// oxlint-disable-next-line effecttsgo/crypto-random-uuid
		const key = pending?.key ?? crypto.randomUUID();
		run(
			Effect.gen(function* () {
				const input = {
					agent,
					label,
					scopes: ["read", ...(write ? ["write"] : []), ...(fs ? ["fs"] : [])],
					long_lived: long,
				};
				const attempt = pending ?? {
					input,
					key,
					proof: yield* confirmAccountAction("token.mint", { ...input, idempotency_key: key }),
				};
				// Preserve the same proof, body and key if an acknowledged response is lost.
				setPending(attempt);
				const result = yield* accountPost("/_boot/tokens", attempt.input, attempt.proof, attempt.key).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(TokenPair)),
					Effect.catchTag("SchemaError", () => unreadable),
				);
				setPair(result);
				setPending(null);
				reload();
			}),
		);
	};
	return (
		<section className="mt-8 text-[13px]" aria-labelledby="account-tokens-heading">
			<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
				<h2 id="account-tokens-heading">Agent access</h2>
				<button
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
					type="button"
					disabled={busy}
					onClick={() => {
						setError(null);
						reload();
					}}
				>
					Refresh tokens
				</button>
			</div>
			<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
				Revoking an instance ends access for every token in its family, including refreshed tokens.
			</p>
			{families?.items.map((family) => (
				<article
					className="flex items-center justify-between gap-3 border-b border-[#e3e8df] py-4 [&>div]:min-w-0 [&>div]:wrap-anywhere [&_strong]:min-w-0 [&_strong]:wrap-anywhere [&_p]:my-[5px] [&_p]:text-[#737d6d] [&_small]:wrap-anywhere [&_small]:text-[#939b89] [&_button]:max-w-[48%] [&_button]:shrink-0 [&_button]:wrap-anywhere"
					key={family.family}
				>
					<div>
						<strong>
							{family.agent}@{family.label}
						</strong>
						<p>
							{family.scopes.join(", ")} · {family.revoked ? "Revoked" : "Issued"}
						</p>
						<small>{family.family}</small>
					</div>
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="button"
						disabled={busy || family.revoked}
						onClick={() =>
							run(
								Effect.gen(function* () {
									const proof = yield* confirmAccountAction("token.revoke", { family: family.family });
									yield* accountPost(`/_boot/tokens/${family.family}/revoke`, {}, proof);
									reload();
								}),
							)
						}
					>
						Revoke
					</button>
				</article>
			))}
			{families && !families.items.length && (
				<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">No issued agent tokens.</p>
			)}
			<form
				className="rounded-[10px] border border-[#dfe5d8] bg-white p-[17px] min-[651px]:p-[22px] mt-[18px] [&_h3]:text-sm [&_fieldset]:mb-4 [&_fieldset]:min-w-0 [&_button]:mt-[14px]"
				onSubmit={(event) => {
					event.preventDefault();
					mint();
				}}
			>
				<h3>Create agent tokens</h3>
				<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
					Read access is included. Confirm the identity and permissions with your passkey.
				</p>
				<fieldset disabled={busy || pending !== null || pair !== null}>
					<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="token-agent">
						Agent name
					</label>
					<input
						className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
						id="token-agent"
						required
						maxLength={64}
						pattern="[a-z0-9][a-z0-9._\-]*"
						value={agent}
						onChange={(event) => setAgent(event.target.value)}
						placeholder="codex"
					/>
					<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="token-label">
						Instance label
					</label>
					<input
						className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
						id="token-label"
						required
						maxLength={100}
						pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="macbook"
					/>
					<label className="mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c] flex items-center gap-[9px]">
						<input
							className="disabled:opacity-75"
							type="checkbox"
							checked={write}
							onChange={(event) => setWrite(event.target.checked)}
						/>{" "}
						Write messages and topics
					</label>
					<label className="mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c] flex items-center gap-[9px]">
						<input
							className="disabled:opacity-75"
							type="checkbox"
							checked={fs}
							onChange={(event) => setFs(event.target.checked)}
						/>{" "}
						Edit source and pages
					</label>
					<label className="mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c] flex items-center gap-[9px]">
						<input
							className="disabled:opacity-75"
							type="checkbox"
							checked={long}
							onChange={(event) => setLong(event.target.checked)}
						/>{" "}
						Long-lived: access 7 days, refresh 90 days
					</label>
					<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
						Default: access 24 hours, refresh 30 days.
					</p>
				</fieldset>
				{pending && (
					<p role="status">
						A token request is pending. Retry unchanged to recover its result. If recovery fails, check the token list
						and revoke the uncertain instance, then reload this page before creating another.
					</p>
				)}
				{!pair && (
					<button
						className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
						type="submit"
						disabled={busy}
					>
						{busy ? "Waiting for confirmation…" : pending ? "Retry token request" : "Create with passkey"}
					</button>
				)}
				{pair && (
					<div className="mt-5 [&_textarea]:min-h-20 [&_textarea]:font-mono [&_textarea]:wrap-anywhere">
						<h3>Save this token pair</h3>
						<p>
							These secrets are shown only here. Closing this view removes them from the page; they cannot be retrieved
							from the token list.
						</p>
						<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="token-access">
							Access token
						</label>
						<textarea
							className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c] min-h-[125px] resize-y"
							id="token-access"
							readOnly
							value={pair.access}
							autoComplete="off"
							spellCheck={false}
						/>
						<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="token-refresh">
							Refresh token
						</label>
						<textarea
							className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c] min-h-[125px] resize-y"
							id="token-refresh"
							readOnly
							value={pair.refresh}
							autoComplete="off"
							spellCheck={false}
						/>
						<button
							className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
							type="button"
							onClick={() => setPair(null)}
						>
							I saved them — hide tokens
						</button>
					</div>
				)}
			</form>
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
	);
}
