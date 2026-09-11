import { Effect, Schema } from "effect";
import { useEffect, useState } from "react";
import { type BoardError } from "./board-api.ts";
import { accountPost, getFamilies, TokenPair, type FamilyList, unreadable } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";

type MintInput = {
	readonly agent: string;
	readonly label: string;
	readonly scopes: readonly string[];
	readonly long_lived: boolean;
};
type PendingMint = { readonly input: MintInput; readonly key: string; readonly proof: string };
export function AccountTokens() {
	const [families, setFamilies] = useState<FamilyList>({ items: [], next: null });
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [agent, setAgent] = useState("");
	const [label, setLabel] = useState("");
	const [write, setWrite] = useState(true);
	const [fs, setFs] = useState(false);
	const [long, setLong] = useState(false);
	const [pending, setPending] = useState<PendingMint | null>(null);
	const [pair, setPair] = useState<TokenPair | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		void Effect.runPromise(getFamilies().pipe(Effect.result), { signal: controller.signal })
			.then((result) => {
				if (result._tag === "Success") setFamilies(result.success);
				else setError(result.failure);
			})
			.catch(() => {});
		return () => controller.abort();
	}, [refresh]);
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
				setRefresh((value) => value + 1);
			}),
		);
	};
	return (
		<section className="account-section" aria-labelledby="account-tokens-heading">
			<div className="section-heading">
				<h2 id="account-tokens-heading">Agent access</h2>
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						setError(null);
						setRefresh((value) => value + 1);
					}}
				>
					Refresh tokens
				</button>
			</div>
			<p className="field-hint">
				Revoking an instance ends access for every token in its family, including refreshed tokens.
			</p>
			{families.items.map((family) => (
				<article className="account-row" key={family.family}>
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
									setRefresh((value) => value + 1);
								}),
							)
						}
					>
						Revoke
					</button>
				</article>
			))}
			{!families.items.length && <p className="field-hint">No issued agent tokens.</p>}
			{families.next && (
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						run(
							getFamilies(families.next).pipe(
								Effect.map((page) =>
									setFamilies((current) => ({ items: [...current.items, ...page.items], next: page.next })),
								),
							),
						)
					}
				>
					More tokens
				</button>
			)}
			<form
				className="composer account-form"
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
					<label className="account-check">
						<input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /> Write
						messages and topics
					</label>
					<label className="account-check">
						<input type="checkbox" checked={fs} onChange={(event) => setFs(event.target.checked)} /> Edit source and
						pages
					</label>
					<label className="account-check">
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
					<div className="account-secrets">
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
	);
}
