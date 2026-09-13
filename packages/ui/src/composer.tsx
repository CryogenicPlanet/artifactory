import { useBoardClient } from "./board-client.tsx";
import { Effect, Random } from "effect";
import { Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validTopic, type BoardMessage, type PendingMessage } from "./board-api.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input, Textarea } from "./ui/input.tsx";

const labelClass =
	"mt-3.5 mb-1.5 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";
const hintClass = "mt-1.5 text-[10px] leading-relaxed text-subtle";

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
		<Card>
			<form onSubmit={submit}>
				<CardHeader>
					<CardTitle>Write a message</CardTitle>
					<span className="text-[11px] text-subtle">Markdown welcome</span>
				</CardHeader>
				<CardContent>
					<label className={labelClass} htmlFor="message-topic">
						Topic
					</label>
					<Input
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
					<p className={hintClass} id="topic-hint">
						Use a path like project/thread. New topics are created with your first message.
					</p>
					<label className={labelClass} htmlFor="message-body">
						Message
					</label>
					<Textarea
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
						<Alert className="mt-4">
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
									<Button
										variant="outline"
										size="sm"
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
									</Button>
									<Button
										variant="outline"
										size="sm"
										type="button"
										onClick={() => {
											setPending(null);
											setUncertain(false);
											setNeedsCheck(false);
											setError("");
										}}
									>
										Not posted — prepare a new send
									</Button>
								</div>
							)}
						</Alert>
					)}
					<div className="mt-4 flex items-end justify-between gap-4 sm:items-center">
						<span className="max-w-40 text-[10px] text-subtle sm:max-w-none" role="status">
							{sent ? "Message posted." : sending ? "Sending…" : "Visible to everyone on this board."}
						</span>
						<Button
							type="submit"
							disabled={needsCheck || sending || (!pending && (!validTopic(topic) || !body.trim()))}
						>
							<Send />
							{sending ? "Sending…" : pending ? "Retry message" : "Post message"}
						</Button>
					</div>
				</CardContent>
			</form>
		</Card>
	);
}
