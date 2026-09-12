import { Effect } from "effect";
import { useState } from "react";
import { breakEditLock, revertSource } from "./recovery-api.ts";
import { type EditLock } from "./extension-api.ts";
import { Link } from "./router.tsx";
import { Button } from "./ui/button.tsx";

/** The mounted controls retain uncertain undo identity; refreshing reads never starts another undo. */
export function RecoveryControls({
	lock,
	refresh,
}: {
	readonly lock: EditLock | null | undefined;
	readonly refresh: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const run = (action: "break" | "revert") => {
		if (busy || pending !== null || (action === "break" && !lock)) return;
		setBusy(true);
		setMessage(action === "break" ? "Waiting for a fresh passkey confirmation…" : "Reverting the last source change…");
		void Effect.runPromise(
			Effect.gen(function* () {
				if (action === "break") {
					if (!lock) return;
					yield* breakEditLock(lock.id);
					setMessage(
						"Break accepted. A pinned lock is released only when its cutover finishes; check the refreshed lock status.",
					);
				} else {
					const key = crypto.randomUUID();
					setPending(key);
					const result = yield* revertSource(key);
					setMessage(
						result.status === "live"
							? `Source reverted in generation ${result.generation}. Open the board to check it.`
							: `Revert failed in generation ${result.generation}: ${result.error ?? "check boot diagnostics"}. Repair the source before another change.`,
					);
					// Do not retry from this page: a login in another tab changes the receipt scope.
				}
			}).pipe(Effect.result),
		).then((result) => {
			if (result._tag === "Failure")
				setMessage(
					`${result.failure.message} Check boot diagnostics and refresh lock status.${action === "revert" ? " An undo may have completed. Inspect its outcome before leaving this page or starting another undo." : ""}`,
				);
			setBusy(false);
			refresh();
		});
	};
	return (
		<div className="mt-5 space-y-3">
			<p>
				Revert restores the last app source change and keeps messages, pages and identities. An existing editor’s lock
				is preserved. Pending edits must be resolved first.
			</p>
			<div className="flex flex-wrap gap-3">
				{lock && (
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={busy || pending !== null}
						onClick={() => run("break")}
					>
						Break lock with passkey
					</Button>
				)}
				<Button
					variant="outline"
					size="sm"
					type="button"
					disabled={busy || pending !== null}
					onClick={() => run("revert")}
				>
					{pending ? "Undo requested — check boot diagnostics" : "Revert last source change"}
				</Button>
			</div>
			{message && <p role="status">{message}</p>}
			<p>
				<a href="/auth/login">Sign in with a passkey</a> · <a href="/_boot/status">Boot diagnostics</a> ·{" "}
				<Link href="/">Open board</Link>
			</p>
		</div>
	);
}
