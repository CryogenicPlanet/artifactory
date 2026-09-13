import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

const badgeVariants = cva(
	"inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.04em] wrap-anywhere tabular-nums",
	{
		variants: {
			variant: {
				default: "bg-accent-surface text-accent-foreground",
				muted: "border border-tag-border bg-tag-surface text-tag",
				outline: "border border-border text-muted-foreground",
				destructive: "bg-destructive-surface text-destructive",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

export function Badge({
	className,
	variant,
	...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
