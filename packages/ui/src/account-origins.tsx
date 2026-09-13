import { useLoad } from "./use-load.ts";
import { Effect } from "effect";
import { useState } from "react";
import { type BoardError } from "./board-api.ts";
import {
	createPasskeyCode,
	getOrigins,
	removeOrigin,
	revokePasskeyCode,
	type PasskeyCode,
} from "./account-origins-api.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

/** One-time codes add a passkey on another device or domain; runtime domains are listed and removable here. */
export function AccountOrigins() {
	const { value: origins, error: loadError, reload } = useLoad(getOrigins);
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [domain, setDomain] = useState("");
	const [code, setCode] = useState<PasskeyCode | null>(null);
	const [message, setMessage] = useState("");
	const run = <A,>(operation: Effect.Effect<A, BoardError>, success: string, done?: (value: A) => void) => {
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
				done?.(result.success);
			}
		});
	};
	const target = code?.origin ?? window.location.origin;
	return (
		<section className="mt-8 text-[13px]" aria-labelledby="account-origins-heading">
			<SectionHeading title={<span id="account-origins-heading">Domains and one-time codes</span>} />
			{origins?.items.map((item) => (
				<article className="flex items-center justify-between gap-3 border-b border-border py-4" key={item.origin}>
					<span className="min-w-0 wrap-anywhere">
						<strong>{item.origin}</strong>{" "}
						<span className="text-muted-foreground">
							{item.status === "pending" ? "pending code" : item.source === "config" ? "configured" : "added"} ·{" "}
							{item.passkeys} passkey{item.passkeys === 1 ? "" : "s"}
						</span>
					</span>
					{item.removable && (
						<Button
							variant="outline"
							size="sm"
							type="button"
							disabled={busy}
							onClick={() => run(removeOrigin(item.origin), "Domain removed.")}
						>
							Remove {item.origin}
						</Button>
					)}
				</article>
			))}
			<Card className="mt-4">
				<CardContent>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							run(createPasskeyCode(domain.trim()), "Code created. It is shown only once.", setCode);
						}}
					>
						<label
							className="mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
							htmlFor="passkey-code-domain"
						>
							New domain (optional)
						</label>
						<Input
							id="passkey-code-domain"
							value={domain}
							disabled={busy}
							onChange={(event) => setDomain(event.target.value)}
							placeholder="https://chirp.example.com"
						/>
						<p className="mt-1.5 text-[10px] leading-relaxed text-subtle">
							Point the domain at this board with your host and DNS first; the code can only be redeemed from an address
							that reaches this board. Leave it empty to add a passkey on another device here.
						</p>
						<Button className="mt-3.5" variant="outline" size="sm" type="submit" disabled={busy}>
							Generate add-passkey code
						</Button>
					</form>
					{code && (
						<div className="mt-4">
							<p>
								Code <strong className="font-mono">{code.code}</strong>, valid until{" "}
								{new Date(code.expires_at).toLocaleTimeString()}. Open{" "}
								<a href={`${target}/auth/passkey-code`}>{`${target}/auth/passkey-code`}</a> and enter it.
							</p>
							<Button
								className="mt-2"
								variant="outline"
								size="sm"
								type="button"
								disabled={busy}
								onClick={() => run(revokePasskeyCode, "Code revoked.", () => setCode(null))}
							>
								Revoke code
							</Button>
						</div>
					)}
				</CardContent>
			</Card>
			<p className="mt-3 text-xs text-muted-foreground" role="status">
				{message}
			</p>
			{(error ?? loadError) && <Alert className="mt-4">{(error ?? loadError)?.message}</Alert>}
		</section>
	);
}
