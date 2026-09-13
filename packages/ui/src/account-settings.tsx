import { Effect } from "effect";
import { useState } from "react";
import { useLoad } from "./use-load.ts";
import { confirmAccountAction } from "./account-passkeys.ts";
import { changeSettings, getSettings, settingsError, type Settings, type SettingsChange } from "./settings-api.ts";
import { type BoardError } from "./board-api.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { Input, Textarea } from "./ui/input.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

type Pending = { readonly body: SettingsChange; readonly proof: string; readonly observed: Settings };

const labelClass =
	"mt-3.5 mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const hintClass = "mt-1.5 text-[10px] leading-relaxed text-subtle";

export function AccountSettings() {
	const { value, error, loading, reload, update } = useLoad(getSettings);
	return (
		<section className="mt-8 text-[13px]" aria-labelledby="account-settings-heading">
			<SectionHeading title={<span id="account-settings-heading">Board settings</span>}>
				<Button variant="outline" size="sm" type="button" disabled={loading} onClick={reload}>
					Refresh settings
				</Button>
			</SectionHeading>
			<p className={hintClass}>
				Changes require a fresh passkey confirmation. Public paths expose exact app routes without sign-in; child paths
				are not included.
			</p>
			{error && (
				<Alert className="mt-4">
					{error.message}
					{error.status === 401 && (
						<p>
							<a href="/auth/login">Sign in again</a>
						</p>
					)}
				</Alert>
			)}
			{!value && loading && (
				<p className="mt-3 text-xs text-muted-foreground" role="status">
					Loading settings…
				</p>
			)}
			{value && (
				<SettingsForm
					current={value}
					onSaved={(value) => {
						update((previous) => (previous && previous.revision > value.revision ? previous : value));
						reload();
					}}
					refresh={reload}
					readBlocked={loading || error !== null}
				/>
			)}
		</section>
	);
}
function SettingsForm({
	current,
	onSaved,
	refresh,
	readBlocked,
}: {
	readonly current: Settings;
	readonly onSaved: (value: Settings) => void;
	readonly refresh: () => void;
	readonly readBlocked: boolean;
}) {
	const [revision, setRevision] = useState(current.revision);
	const [backup, setBackup] = useState(String(current.storage.backup_percent));
	const [events, setEvents] = useState(String(current.storage.event_percent));
	const [headroom, setHeadroom] = useState(String(current.storage.headroom_percent));
	const [paths, setPaths] = useState(current.public_paths.join("\n"));
	const [pending, setPending] = useState<Pending | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<BoardError | null>(null);
	const [message, setMessage] = useState("");
	const changed = current.revision !== revision;
	const valid =
		[backup, events, headroom].every(
			(value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 100,
		) &&
		Number(headroom) >= 5 &&
		Number(backup) + Number(events) + Number(headroom) < 100;
	const save = () => {
		if (busy || readBlocked || (!pending && (!valid || changed))) return;
		setBusy(true);
		setError(null);
		setMessage("Waiting for passkey confirmation…");
		void Effect.runPromise(
			Effect.gen(function* () {
				const body: SettingsChange = {
					revision,
					patch: {
						storage: {
							backup_percent: Number(backup),
							event_percent: Number(events),
							headroom_percent: Number(headroom),
						},
						public_paths: paths
							.split("\n")
							.map((path) => path.trim())
							.filter(Boolean),
					},
				};
				const attempt = pending ?? {
					body,
					proof: yield* confirmAccountAction("settings.change", body),
					observed: current,
				};
				setPending(attempt);
				setMessage("Saving settings…");
				const saved = yield* changeSettings(attempt.body, attempt.proof);
				setPending(null);
				setRevision(saved.revision);
				onSaved(saved);
				setMessage(`Settings saved at revision ${saved.revision}.`);
			}).pipe(Effect.result),
		).then((result) => {
			setBusy(false);
			if (result._tag === "Failure") {
				setError(result.failure.status === 0 ? result.failure : settingsError(result.failure));
				setMessage("");
			}
		});
	};
	return (
		<Card className="mt-4">
			<CardContent>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<p className="text-xs text-muted-foreground">
						Draft revision {revision} · current revision {current.revision}
					</p>
					<fieldset className="min-w-0" disabled={busy || pending !== null}>
						<legend className="pt-2 text-sm font-medium">Storage limits (% of volume)</legend>
						<label className={labelClass} htmlFor="settings-backup">
							Backups
						</label>
						<Input
							id="settings-backup"
							type="number"
							min={0}
							max={100}
							step="any"
							required
							value={backup}
							onChange={(event) => setBackup(event.target.value)}
						/>
						<label className={labelClass} htmlFor="settings-events">
							Events
						</label>
						<Input
							id="settings-events"
							type="number"
							min={0}
							max={100}
							step="any"
							required
							value={events}
							onChange={(event) => setEvents(event.target.value)}
						/>
						<label className={labelClass} htmlFor="settings-headroom">
							Reserved free space
						</label>
						<Input
							id="settings-headroom"
							type="number"
							min={5}
							max={100}
							step="any"
							required
							value={headroom}
							onChange={(event) => setHeadroom(event.target.value)}
						/>
						<p className={hintClass}>
							Reserve at least 5% free space. All three percentages must total less than 100%.
						</p>
						<label className={labelClass} htmlFor="settings-paths">
							Public app paths — one exact path per line
						</label>
						<Textarea
							className="min-h-[125px]"
							id="settings-paths"
							rows={5}
							value={paths}
							onChange={(event) => setPaths(event.target.value)}
							spellCheck={false}
							placeholder="/public-report"
						/>
						<p className={hintClass}>
							At most 128 unique paths, each starting with /. No wildcards, encoded paths, queries, fragments, or
							boot/auth/page routes. An empty list makes no additional app paths public.
						</p>
					</fieldset>
					{(changed || pending) && (
						<Alert className="mt-4">
							<p>
								{pending
									? "This attempt may have completed. Retry the exact signed attempt or compare refreshed settings before starting a new confirmation."
									: "Current settings changed. Your draft is preserved; review the current values before choosing a new revision."}
							</p>
							<p>
								Current storage: backups {current.storage.backup_percent}%, events {current.storage.event_percent}%,
								free space {current.storage.headroom_percent}%.
							</p>
							<p>Current public paths: {current.public_paths.length ? current.public_paths.join(", ") : "none"}.</p>
							<Button variant="outline" size="sm" type="button" disabled={busy || readBlocked} onClick={refresh}>
								Read current settings
							</Button>{" "}
							<Button
								variant="outline"
								size="sm"
								type="button"
								disabled={busy || readBlocked || (pending !== null && current === pending.observed)}
								onClick={() => {
									setRevision(current.revision);
									setPending(null);
									setError(null);
									setMessage("Draft kept. Review it, then confirm with your passkey.");
								}}
							>
								Keep draft with current revision
							</Button>
						</Alert>
					)}
					<Button
						className="mt-4"
						variant="outline"
						size="sm"
						type="submit"
						disabled={busy || readBlocked || (!pending && (!valid || changed))}
					>
						{busy ? "Waiting…" : pending ? "Retry exact signed attempt" : "Save with passkey"}
					</Button>
					{message && (
						<p className="mt-3 text-xs text-muted-foreground" role="status">
							{message}
						</p>
					)}
					{error && <Alert className="mt-4">{error.message}</Alert>}
				</form>
			</CardContent>
		</Card>
	);
}
