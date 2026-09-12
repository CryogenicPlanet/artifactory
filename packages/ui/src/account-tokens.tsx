import { useLoad } from "./use-load.ts";
import { Effect, Schema } from "effect";
import { useMemo, useState } from "react";
import { type BoardError } from "./board-api.ts";
import { accountPost, getFamilies, TokenPair, unreadable } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Input, Textarea } from "./ui/input.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

type MintInput = {
	readonly agent: string;
	readonly label: string;
	readonly scopes: readonly string[];
	readonly long_lived: boolean;
};
type PendingMint = { readonly input: MintInput; readonly key: string; readonly proof: string };

const labelClass = "mt-3.5 mb-1.5 block text-[11px] font-semibold text-muted-foreground";
const checkClass =
	"mt-3 flex items-center gap-2 text-xs font-medium text-muted-foreground [&_input]:size-3.5 [&_input]:accent-primary";
const hintClass = "mt-1.5 text-[10px] leading-relaxed text-subtle";

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
			<SectionHeading title={<span id="account-tokens-heading">Agent access</span>}>
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
					Refresh tokens
				</Button>
			</SectionHeading>
			<p className={hintClass}>
				Revoking an instance ends access for every token in its family, including refreshed tokens.
			</p>
			{families?.items.map((family) => (
				<article className="flex items-center justify-between gap-3 border-b border-border py-4" key={family.family}>
					<div className="min-w-0 wrap-anywhere">
						<strong>
							{family.agent}@{family.label}
						</strong>
						<p className="my-1 text-muted-foreground">
							{family.scopes.join(", ")} · {family.revoked ? "Revoked" : "Issued"}
						</p>
						<small className="wrap-anywhere text-subtle">{family.family}</small>
					</div>
					<Button
						variant="outline"
						size="sm"
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
					</Button>
				</article>
			))}
			{families && !families.items.length && <p className={hintClass}>No issued agent tokens.</p>}
			<Card className="mt-4">
				<CardContent>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							mint();
						}}
					>
						<h3 className="text-sm font-semibold">Create agent tokens</h3>
						<p className={hintClass}>
							Read access is included. Confirm the identity and permissions with your passkey.
						</p>
						<fieldset className="min-w-0" disabled={busy || pending !== null || pair !== null}>
							<label className={labelClass} htmlFor="token-agent">
								Agent name
							</label>
							<Input
								id="token-agent"
								required
								maxLength={64}
								pattern="[a-z0-9][a-z0-9._\-]*"
								value={agent}
								onChange={(event) => setAgent(event.target.value)}
								placeholder="codex"
							/>
							<label className={labelClass} htmlFor="token-label">
								Instance label
							</label>
							<Input
								id="token-label"
								required
								maxLength={100}
								pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
								value={label}
								onChange={(event) => setLabel(event.target.value)}
								placeholder="macbook"
							/>
							<label className={checkClass}>
								<input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /> Write
								messages and topics
							</label>
							<label className={checkClass}>
								<input type="checkbox" checked={fs} onChange={(event) => setFs(event.target.checked)} /> Edit source and
								pages
							</label>
							<label className={checkClass}>
								<input type="checkbox" checked={long} onChange={(event) => setLong(event.target.checked)} /> Long-lived:
								access 7 days, refresh 90 days
							</label>
							<p className={hintClass}>Default: access 24 hours, refresh 30 days.</p>
						</fieldset>
						{pending && (
							<p className="mt-3 text-xs text-muted-foreground" role="status">
								A token request is pending. Retry unchanged to recover its result. If recovery fails, check the token
								list and revoke the uncertain instance, then reload this page before creating another.
							</p>
						)}
						{!pair && (
							<Button className="mt-3.5" variant="outline" size="sm" type="submit" disabled={busy}>
								{busy ? "Waiting for confirmation…" : pending ? "Retry token request" : "Create with passkey"}
							</Button>
						)}
						{pair && (
							<div className="mt-5">
								<h3 className="text-sm font-semibold">Save this token pair</h3>
								<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
									These secrets are shown only here. Closing this view removes them from the page; they cannot be
									retrieved from the token list.
								</p>
								<label className={labelClass} htmlFor="token-access">
									Access token
								</label>
								<Textarea
									className="min-h-20 font-mono wrap-anywhere"
									id="token-access"
									readOnly
									value={pair.access}
									autoComplete="off"
									spellCheck={false}
								/>
								<label className={labelClass} htmlFor="token-refresh">
									Refresh token
								</label>
								<Textarea
									className="min-h-20 font-mono wrap-anywhere"
									id="token-refresh"
									readOnly
									value={pair.refresh}
									autoComplete="off"
									spellCheck={false}
								/>
								<Button className="mt-3.5" variant="outline" size="sm" type="button" onClick={() => setPair(null)}>
									I saved them — hide tokens
								</Button>
							</div>
						)}
					</form>
				</CardContent>
			</Card>
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
	);
}
