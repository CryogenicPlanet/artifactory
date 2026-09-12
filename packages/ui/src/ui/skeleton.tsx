import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

/** Placeholder for the message list while a topic loads. */
export function MessagesSkeleton() {
	return (
		<div role="status" aria-label="Loading" className="space-y-6 pt-2">
			{["w-2/3", "w-1/2", "w-3/5"].map((width) => (
				<div className="flex gap-3" key={width}>
					<Skeleton className="size-8 shrink-0 rounded-lg" />
					<div className="w-full space-y-2 pt-1">
						<Skeleton className="h-3 w-1/4" />
						<Skeleton className={`h-3 ${width}`} />
					</div>
				</div>
			))}
		</div>
	);
}
