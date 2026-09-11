import { Effect } from "effect";
import { useState } from "react";
import { useLoad } from "./use-load.ts";
import { confirmAccountAction } from "./account-passkeys.ts";
import { changeSettings, getSettings, settingsError, type Settings, type SettingsChange } from "./settings-api.ts";
import { type BoardError } from "./board-api.ts";

type Pending = { readonly body: SettingsChange; readonly proof: string; readonly observed: Settings };
export function AccountSettings() {
	const { value, error, loading, reload, update } = useLoad(getSettings);
	return (
		<section className="mt-8 text-[13px]" aria-labelledby="account-settings-heading">
			<div className="section-heading">
				<h2 id="account-settings-heading">Board settings</h2>
				<button type="button" disabled={loading} onClick={reload}>
					Refresh settings
				</button>
			</div>
			<p className="field-hint">
				Changes require a fresh passkey confirmation. Public paths expose exact app routes without sign-in; child paths
				are not included.
			</p>
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
			{!value && loading && <p role="status">Loading settings…</p>}
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
	const [httpDays, setHttpDays] = useState(String(current.event_retention.http_request_days));
	const [otherDays, setOtherDays] = useState(String(current.event_retention.other_days));
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
		Number.isInteger(Number(httpDays)) &&
		Number(httpDays) >= 1 &&
		Number(httpDays) <= 36500 &&
		Number.isInteger(Number(otherDays)) &&
		Number(otherDays) >= 1 &&
		Number(otherDays) <= 36500 &&
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
						event_retention: { http_request_days: Number(httpDays), other_days: Number(otherDays) },
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
		<form
			className="rounded-[10px] border border-[#dfe5d8] bg-white p-[17px] min-[651px]:p-[22px] mt-[18px] [&_fieldset]:mb-4 [&_button]:mt-3"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<p>
				Draft revision {revision} · current revision {current.revision}
			</p>
			<fieldset disabled={busy || pending !== null}>
				<legend>Event retention (days)</legend>
				<label htmlFor="settings-http-days">Request diagnostics</label>
				<input
					id="settings-http-days"
					type="number"
					min={1}
					max={36500}
					required
					value={httpDays}
					onChange={(event) => setHttpDays(event.target.value)}
				/>
				<label htmlFor="settings-other-days">Other events</label>
				<input
					id="settings-other-days"
					type="number"
					min={1}
					max={36500}
					required
					value={otherDays}
					onChange={(event) => setOtherDays(event.target.value)}
				/>
				<h3>Storage limits (% of volume)</h3>
				<label htmlFor="settings-backup">Backups</label>
				<input
					id="settings-backup"
					type="number"
					min={0}
					max={100}
					step="any"
					required
					value={backup}
					onChange={(event) => setBackup(event.target.value)}
				/>
				<label htmlFor="settings-events">Events</label>
				<input
					id="settings-events"
					type="number"
					min={0}
					max={100}
					step="any"
					required
					value={events}
					onChange={(event) => setEvents(event.target.value)}
				/>
				<label htmlFor="settings-headroom">Reserved free space</label>
				<input
					id="settings-headroom"
					type="number"
					min={5}
					max={100}
					step="any"
					required
					value={headroom}
					onChange={(event) => setHeadroom(event.target.value)}
				/>
				<p className="field-hint">Reserve at least 5% free space. All three percentages must total less than 100%.</p>
				<label htmlFor="settings-paths">Public app paths — one exact path per line</label>
				<textarea
					id="settings-paths"
					rows={5}
					value={paths}
					onChange={(event) => setPaths(event.target.value)}
					spellCheck={false}
					placeholder="/public-report"
				/>
				<p className="field-hint">
					At most 128 unique paths, each starting with /. No wildcards, encoded paths, queries, fragments, or
					boot/auth/page routes. An empty list makes no additional app paths public.
				</p>
			</fieldset>
			{(changed || pending) && (
				<div className="notice">
					<p>
						{pending
							? "This attempt may have completed. Retry the exact signed attempt or compare refreshed settings before starting a new confirmation."
							: "Current settings changed. Your draft is preserved; review the current values before choosing a new revision."}
					</p>
					<p>
						Current retention: requests {current.event_retention.http_request_days} days, other events{" "}
						{current.event_retention.other_days} days. Storage: backups {current.storage.backup_percent}%, events{" "}
						{current.storage.event_percent}%, free space {current.storage.headroom_percent}%.
					</p>
					<p>Current public paths: {current.public_paths.length ? current.public_paths.join(", ") : "none"}.</p>
					<button type="button" disabled={busy || readBlocked} onClick={refresh}>
						Read current settings
					</button>{" "}
					<button
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
					</button>
				</div>
			)}
			<button type="submit" disabled={busy || readBlocked || (!pending && (!valid || changed))}>
				{busy ? "Waiting…" : pending ? "Retry exact signed attempt" : "Save with passkey"}
			</button>
			{message && <p role="status">{message}</p>}
			{error && (
				<div className="notice" role="alert">
					{error.message}
				</div>
			)}
		</form>
	);
}
