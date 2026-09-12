import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useBoardClient } from "./board-client.tsx";
import { useLoad } from "./use-load.ts";
import { Message } from "./message.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";
import { MessagesSkeleton } from "./ui/skeleton.tsx";

export function MessageHistory({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
	const client = useBoardClient();
	const [position, setPosition] = useState<{ readonly since: number; readonly previous: readonly number[] }>({
		since: 0,
		previous: [],
	});
	const request = useMemo(
		() => client.messages({ topic: path, since: position.since, limit: 100, mark: "0" }),
		[client, path, position.since],
	);
	const { value, error, loading, reload } = useLoad(request);
	const page = loading || error ? undefined : value;
	return (
		<>
			{page && <ReferencedMessage visible={page.items} />}
			<section className="mb-8" aria-label="Message history">
				<SectionHeading title="Message history">
					<Button variant="outline" size="sm" type="button" onClick={onClose}>
						Back to latest
					</Button>
				</SectionHeading>
				<p className="text-[11px] text-subtle">
					Page {position.previous.length + 1}, oldest first. Return to latest for live updates.
				</p>
				{error ? (
					<Alert className="mt-4">
						<p>{error.message}</p>
						<Button variant="outline" size="sm" type="button" onClick={reload}>
							Retry history
						</Button>
					</Alert>
				) : page === undefined ? (
					<MessagesSkeleton />
				) : (
					<>
						{page.items.map((message) => (
							<Message key={message.id} message={message} />
						))}
						{page.items.length < 100 && (
							<p className="pt-4 text-center text-xs text-subtle" role="status">
								You have reached the end of this topic’s history.
							</p>
						)}
					</>
				)}
				<div className="mt-4 flex items-center justify-between gap-4">
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={position.previous.length === 0}
						onClick={() => {
							const since = position.previous.at(-1);
							if (since !== undefined) setPosition({ since, previous: position.previous.slice(0, -1) });
						}}
					>
						<ChevronLeft />
						Previous page
					</Button>
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={page === undefined || page.items.length < 100}
						onClick={() => {
							if (page) setPosition({ since: page.cursor, previous: [...position.previous, position.since] });
						}}
					>
						Next page
						<ChevronRight />
					</Button>
				</div>
			</section>
		</>
	);
}
