import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-xs", className)}
			{...props}
		/>
	);
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex items-center justify-between gap-4 px-5 pt-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h2 className={cn("text-xs font-semibold tracking-wide text-muted-foreground uppercase", className)} {...props} />
	);
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("px-5 py-4", className)} {...props} />;
}
