import { Effect, Schema } from "effect";
import { useId, useState } from "react";
import { type BoardError } from "./board-api.ts";
import { saveTopic, type TopicMutation } from "./topic-control-api.ts";
import "./topic-controls.css";

export function TopicControls({
	path,
	meta,
	archived,
	parentArchived = false,
	onSaved,
}: {
	readonly path: string;
	readonly meta: Schema.JsonObject;
	readonly archived: boolean;
	readonly parentArchived?: boolean;
	readonly onSaved: (topic: TopicMutation) => void;
}) {
	const fieldId = useId();
	const [draft, setDraft] = useState(() => JSON.stringify(meta, null, 2));
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [error, setError] = useState<BoardError | null>(null);
	const [invalid, setInvalid] = useState(false);
	const [saved, setSaved] = useState("");
	const disabled = busy || uncertain || parentArchived;
	const mutate = (input: { readonly meta: Schema.JsonObject } | { readonly archived: boolean }) => {
		if (disabled) return;
		setBusy(true);
		setError(null);
		setSaved("");
		void Effect.runPromise(saveTopic(path, input).pipe(Effect.result)).then((result) => {
			setBusy(false);
			if (result._tag === "Failure") {
				setError(result.failure);
				setUncertain(result.failure.status === 0 || result.failure.status >= 500 || result.failure.status === 408);
			} else {
				if ("meta" in input) {
					setDraft(JSON.stringify(result.success.meta, null, 2));
					setDirty(false);
				}
				setSaved("meta" in input ? "Metadata saved." : input.archived ? "Topic archived." : "Topic unarchived.");
				onSaved(result.success);
			}
		});
	};
	return (
		<details
			className="topic-controls"
			onToggle={(event) => {
				if (event.currentTarget.open && !busy && !uncertain && !dirty) {
					setDraft(JSON.stringify(meta, null, 2));
					setInvalid(false);
				}
			}}
		>
			<summary>Topic settings{archived || parentArchived ? " · archived" : ""}</summary>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (disabled || archived) return;
					const parsed = Schema.decodeResult(Schema.fromJsonString(Schema.JsonObject))(draft);
					if (parsed._tag === "Failure") {
						setInvalid(true);
						return;
					}
					setInvalid(false);
					mutate({ meta: parsed.success });
				}}
			>
				<label htmlFor={fieldId}>Metadata</label>
				<p className="field-hint" id={`${fieldId}-hint`}>
					Save replaces all metadata. Omitted keys are removed. Setting public to true makes this topic’s pages public.
				</p>
				<textarea
					id={fieldId}
					aria-describedby={`${fieldId}-hint`}
					aria-invalid={invalid}
					spellCheck={false}
					value={draft}
					disabled={disabled || archived}
					onChange={(event) => {
						setDraft(event.target.value);
						setDirty(true);
						setInvalid(false);
						setSaved("");
					}}
				/>
				{invalid && <p role="alert">Enter a valid JSON object, such as {`{"status":"doing"}`}.</p>}
				<button type="submit" disabled={disabled || archived}>
					Save metadata
				</button>
			</form>
			<div className="topic-archive-controls">
				<p className="field-hint">
					{parentArchived
						? "A parent topic is archived. Unarchive the parent before changing this topic."
						: archived
							? "This topic is archived. Unarchive it to write messages or edit metadata."
							: "Archiving makes this topic and its subtopics read-only and hides them from unread counts."}
				</p>
				<button type="button" disabled={disabled} onClick={() => mutate({ archived: !archived })}>
					{archived ? "Unarchive topic" : "Archive topic"}
				</button>
			</div>
			{error && (
				<div className="notice" role="alert">
					<p>{error.message}</p>
					{error.status === 401 && (
						<a href="/auth/login" target="_blank" rel="noreferrer">
							Sign in with a passkey, then try again
						</a>
					)}
					{uncertain && (
						<>
							<p>The change may have saved. Reload and check this topic before making another change.</p>
							<button type="button" onClick={() => window.location.reload()}>
								Reload topic
							</button>
						</>
					)}
				</div>
			)}
			<p className="field-hint" role="status">
				{busy ? "Saving…" : saved}
			</p>
		</details>
	);
}
