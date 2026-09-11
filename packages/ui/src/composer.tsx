import { useBoardClient } from "./board-client.tsx";
import { Effect, Random } from "effect";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validTopic, type BoardMessage, type PendingMessage } from "./board-api.ts";

export function Composer({
	path,
	onSent,
	sessionExpired,
}: {
	readonly path: string;
	readonly sessionExpired: boolean;
	readonly onSent: (message: BoardMessage) => void;
}) {
	const { sendMessage } = useBoardClient();
	const [topic, setTopic] = useState(path);
	const [body, setBody] = useState("");
	const [pending, setPending] = useState<PendingMessage | null>(null);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");
	const [authRequired, setAuthRequired] = useState(false);
	const [sent, setSent] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [needsCheck, setNeedsCheck] = useState(false);
	useEffect(() => {
		if (sessionExpired && uncertain) {
			setNeedsCheck(true);
			setAuthRequired(true);
		}
	}, [sessionExpired, uncertain]);
	const inFlight = useRef(false);
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (needsCheck || inFlight.current || (!pending && (!validTopic(topic) || !body.trim()))) return;
		inFlight.current = true;
		setSending(true);
		setError("");
		setSent(false);
		const send = Effect.gen(function* () {
			const attempt = pending ?? {
				topic,
				body,
				key: (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join("-"),
			};
			setPending(attempt);
			const result = yield* sendMessage(attempt).pipe(Effect.result);
			if (result._tag === "Success") {
				setPending(null);
				setUncertain(false);
				setNeedsCheck(false);
				setBody("");
				setSent(true);
				onSent(result.success);
			} else {
				setError(result.failure.message);
				setAuthRequired(result.failure.status === 401);
				if (result.failure.status === 0 || result.failure.status >= 500) setUncertain(true);
				if (result.failure.status === 401 && uncertain) setNeedsCheck(true);
				if ([400, 403, 409, 413, 422].includes(result.failure.status)) {
					if (uncertain) setNeedsCheck(true);
					else setPending(null);
				}
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					inFlight.current = false;
					setSending(false);
				}),
			),
		);
		Effect.runFork(send);
	};
	return (
		<form className="rounded-[10px] border border-[#dfe5d8] bg-white p-[17px] min-[651px]:p-[22px]" onSubmit={submit}>
			<div className="mb-[18px] flex items-center justify-between gap-[15px] [&_h2]:m-0 [&_h2]:text-xs [&_h2]:font-[650] [&>span]:text-[11px] [&>span]:text-[#93998d]">
				<h2>Write a message</h2>
				<span>Markdown welcome</span>
			</div>
			<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="message-topic">
				Topic
			</label>
			<input
				className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c]"
				id="message-topic"
				name="topic"
				value={topic}
				placeholder="project/thread"
				required
				maxLength={200}
				disabled={pending !== null}
				onChange={(event) => {
					setTopic(event.target.value);
					setSent(false);
				}}
				aria-describedby="topic-hint"
			/>
			<p className="mt-[5px] mb-0 text-[10px] leading-[1.6] text-[#939b89]" id="topic-hint">
				Use a path like project/thread. New topics are created with your first message.
			</p>
			<label className="block mt-[14px] mb-1.5 text-[11px] font-semibold text-[#646e5c]" htmlFor="message-body">
				Message
			</label>
			<textarea
				className="disabled:opacity-75 w-full min-w-0 rounded-md border border-[#dfe4d8] bg-[#fcfdfa] px-3 py-2.5 text-[13px] leading-[1.6] text-[#32392c] min-h-[125px] resize-y"
				id="message-body"
				name="body"
				value={body}
				placeholder="Share an update, ask a question, or leave some context…"
				required
				maxLength={65536}
				rows={4}
				disabled={pending !== null}
				onChange={(event) => {
					setBody(event.target.value);
					setSent(false);
				}}
			/>
			{(error || needsCheck) && (
				<div
					className="rounded-lg border border-[#eadbc6] bg-[#fff9ef] text-[12px] leading-[1.7] text-[#87683f] [&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-[#6c573b] [&_p]:mt-0 [&_p]:mb-3 [&_a]:underline [&_a]:underline-offset-[3px] mt-[15px] mb-0 p-[13px] "
					role="alert"
				>
					<p>{needsCheck ? "A previous attempt may already be saved." : error}</p>
					<p>
						{needsCheck
							? "Check whether this message is already on the board before preparing a new send."
							: pending
								? "Your message is kept here. Retry sends the same message safely."
								: "Your draft is kept here. Update it and try again."}
					</p>
					{authRequired && (
						<a href="/auth/login" target="_blank" rel="noreferrer">
							Sign in in a new tab
						</a>
					)}
					{needsCheck && (
						<div className="mt-3 flex flex-wrap gap-2">
							<button
								className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
								type="button"
								onClick={() => {
									setPending(null);
									setBody("");
									setUncertain(false);
									setNeedsCheck(false);
									setError("");
								}}
							>
								I found it — clear draft
							</button>
							<button
								className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold border-[#d8ded5] bg-white text-[13px] disabled:cursor-default disabled:opacity-50 [&:not(:disabled):hover]:bg-[#eef3eb]"
								type="button"
								onClick={() => {
									setPending(null);
									setUncertain(false);
									setNeedsCheck(false);
									setError("");
								}}
							>
								Not posted — prepare a new send
							</button>
						</div>
					)}
				</div>
			)}
			<div className="mt-[15px] flex items-end justify-between gap-[15px] min-[651px]:items-center [&>span]:max-w-40 [&>span]:text-[10px] [&>span]:text-[#8e9783] min-[651px]:[&>span]:max-w-none">
				<span role="status">
					{sent ? "Message posted." : sending ? "Sending…" : "Visible to everyone on this board."}
				</span>
				<button
					type="submit"
					className="cursor-pointer rounded-[7px] border px-[14px] py-[9px] font-semibold disabled:cursor-default disabled:opacity-50 text-[13px] border-[#4c6840] bg-[#4c6840] text-white [&:not(:disabled):hover]:bg-[#3c5631] [&:not(:disabled):hover]:text-white"
					disabled={needsCheck || sending || (!pending && (!validTopic(topic) || !body.trim()))}
				>
					{sending ? "Sending…" : pending ? "Retry message" : "Post message"}
				</button>
			</div>
		</form>
	);
}
