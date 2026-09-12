import { Effect, Schema } from "effect";
import { ChevronRight, Settings2 } from "lucide-react";
import { useId, useState } from "react";
import { type BoardError } from "./board-api.ts";
import type { TopicMutation } from "@comms/protocol";
import { useBoardClient } from "./board-client.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/input.tsx";

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
	readonly onSaved: (topic: typeof TopicMutation.Type) => void;
}) {
	const { saveTopic } = useBoardClient();
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
			className="group mb-7 rounded-lg border border-border bg-card px-4 py-3 text-[13px]"
			onToggle={(event) => {
				if (event.currentTarget.open && !busy && !uncertain && !dirty) {
					setDraft(JSON.stringify(meta, null, 2));
					setInvalid(false);
				}
			}}
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
				<Settings2 className="size-3.5" />
				Topic settings{archived || parentArchived ? " · archived" : ""}
				<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
			</summary>
			<form
				className="mt-4"
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
				<label className="mb-1.5 block text-[11px] font-semibold text-muted-foreground" htmlFor={fieldId}>
					Metadata
				</label>
				<p className="mb-2 text-[10px] leading-relaxed text-subtle" id={`${fieldId}-hint`}>
					Save replaces all metadata. Omitted keys are removed. Setting public to true makes this topic’s pages public.
				</p>
				<Textarea
					className="min-h-[140px] font-mono"
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
				{invalid && (
					<p className="mt-2 text-xs text-destructive" role="alert">
						Enter a valid JSON object, such as {`{"status":"doing"}`}.
					</p>
				)}
				<Button className="mt-3" variant="outline" size="sm" type="submit" disabled={disabled || archived}>
					Save metadata
				</Button>
			</form>
			<div className="mt-5 border-t border-border pt-3">
				<p className="mb-2 text-[10px] leading-relaxed text-subtle">
					{parentArchived
						? "A parent topic is archived. Unarchive the parent before changing this topic."
						: archived
							? "This topic is archived. Unarchive it to write messages or edit metadata."
							: "Archiving makes this topic and its subtopics read-only and hides them from unread counts."}
				</p>
				<Button
					variant="outline"
					size="sm"
					type="button"
					disabled={disabled}
					onClick={() => mutate({ archived: !archived })}
				>
					{archived ? "Unarchive topic" : "Archive topic"}
				</Button>
			</div>
			{error && (
				<Alert className="mt-4">
					<p>{error.message}</p>
					{error.status === 401 && (
						<a href="/auth/login" target="_blank" rel="noreferrer">
							Sign in with a passkey, then try again
						</a>
					)}
					{uncertain && (
						<>
							<p>The change may have saved. Reload and check this topic before making another change.</p>
							<Button variant="outline" size="sm" type="button" onClick={() => window.location.reload()}>
								Reload topic
							</Button>
						</>
					)}
				</Alert>
			)}
			<p className="mt-3 text-[10px] leading-relaxed text-subtle" role="status">
				{busy ? "Saving…" : saved}
			</p>
		</details>
	);
}
