import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

const alertVariants = cva(
	"rounded-lg border p-4 text-xs leading-relaxed [&_h2]:mt-0 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold [&_p]:my-2 [&_a]:underline [&_a]:underline-offset-[3px]",
	{
		variants: {
			variant: {
				warning: "border-warning-border bg-warning-surface text-warning [&_h2]:text-warning-heading",
				destructive: "border-destructive/25 bg-destructive-surface text-destructive",
			},
		},
		defaultVariants: { variant: "warning" },
	},
);

export function Alert({
	className,
	variant,
	...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
	return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
