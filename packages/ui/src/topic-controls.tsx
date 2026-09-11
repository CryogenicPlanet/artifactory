import { Effect, Schema } from "effect";
import { useId, useState } from "react";
import { type BoardError } from "./board-api.ts";
import type { TopicMutation } from "@comms/protocol";
import { useBoardClient } from "./board-client.tsx";

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
			className="mb-7 rounded-lg border border-[#e3e8df] px-[18px] py-[14px] text-[13px] [&>summary]:cursor-pointer [&>summary]:font-semibold [&>summary]:text-[#68705f] [&>form]:mt-5 [&_textarea]:min-h-[140px] [&_textarea]:font-mono"
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
				<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor={fieldId}>
					Metadata
				</label>
				<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]" id={`${fieldId}-hint`}>
					Save replaces all metadata. Omitted keys are removed. Setting public to true makes this topic’s pages public.
				</p>
				<textarea
					className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c] min-h-[125px] resize-y"
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
				<button
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
					type="submit"
					disabled={disabled || archived}
				>
					Save metadata
				</button>
			</form>
			<div className="mt-5 border-t border-[#e3e8df] pt-2">
				<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]">
					{parentArchived
						? "A parent topic is archived. Unarchive the parent before changing this topic."
						: archived
							? "This topic is archived. Unarchive it to write messages or edit metadata."
							: "Archiving makes this topic and its subtopics read-only and hides them from unread counts."}
				</p>
				<button
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
					type="button"
					disabled={disabled}
					onClick={() => mutate({ archived: !archived })}
				>
					{archived ? "Unarchive topic" : "Archive topic"}
				</button>
			</div>
			{error && (
				<div
					className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mb-5 p-5"
					role="alert"
				>
					<p>{error.message}</p>
					{error.status === 401 && (
						<a href="/auth/login" target="_blank" rel="noreferrer">
							Sign in with a passkey, then try again
						</a>
					)}
					{uncertain && (
						<>
							<p>The change may have saved. Reload and check this topic before making another change.</p>
							<button
								className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
								type="button"
								onClick={() => window.location.reload()}
							>
								Reload topic
							</button>
						</>
					)}
				</div>
			)}
			<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]" role="status">
				{busy ? "Saving…" : saved}
			</p>
		</details>
	);
}
