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
			<div className="section-heading">
				<h2 id="account-tokens-heading">Agent access</h2>
				<button
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
			<p className="field-hint">
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
			{families && !families.items.length && <p className="field-hint">No issued agent tokens.</p>}
			<form
				className="rounded-[10px] border border-[#dfe5d8] bg-white p-[17px] min-[651px]:p-[22px] mt-[18px] [&_h3]:text-sm [&_fieldset]:mb-4 [&_fieldset]:min-w-0 [&_button]:mt-[14px]"
				onSubmit={(event) => {
					event.preventDefault();
					mint();
				}}
			>
				<h3>Create agent tokens</h3>
				<p className="field-hint">Read access is included. Confirm the identity and permissions with your passkey.</p>
				<fieldset disabled={busy || pending !== null || pair !== null}>
					<label htmlFor="token-agent">Agent name</label>
					<input
						id="token-agent"
						required
						maxLength={64}
						pattern="[a-z0-9][a-z0-9._\-]*"
						value={agent}
						onChange={(event) => setAgent(event.target.value)}
						placeholder="codex"
					/>
					<label htmlFor="token-label">Instance label</label>
					<input
						id="token-label"
						required
						maxLength={100}
						pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
						value={label}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="macbook"
					/>
					<label className="flex items-center gap-[9px]">
						<input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /> Write
						messages and topics
					</label>
					<label className="flex items-center gap-[9px]">
						<input type="checkbox" checked={fs} onChange={(event) => setFs(event.target.checked)} /> Edit source and
						pages
					</label>
					<label className="flex items-center gap-[9px]">
						<input type="checkbox" checked={long} onChange={(event) => setLong(event.target.checked)} /> Long-lived:
						access 7 days, refresh 90 days
					</label>
					<p className="field-hint">Default: access 24 hours, refresh 30 days.</p>
				</fieldset>
				{pending && (
					<p role="status">
						A token request is pending. Retry unchanged to recover its result. If recovery fails, check the token list
						and revoke the uncertain instance, then reload this page before creating another.
					</p>
				)}
				{!pair && (
					<button type="submit" disabled={busy}>
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
						<label htmlFor="token-access">Access token</label>
						<textarea id="token-access" readOnly value={pair.access} autoComplete="off" spellCheck={false} />
						<label htmlFor="token-refresh">Refresh token</label>
						<textarea id="token-refresh" readOnly value={pair.refresh} autoComplete="off" spellCheck={false} />
						<button type="button" onClick={() => setPair(null)}>
							I saved them — hide tokens
						</button>
					</div>
				)}
			</form>
			{(error ?? loadError) && (
				<div className="notice" role="alert">
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
