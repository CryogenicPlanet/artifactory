import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";

export const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-semibold whitespace-nowrap transition-all not-disabled:active:scale-[0.98] disabled:cursor-default disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover",
				outline: "border border-input bg-card text-foreground not-disabled:hover:bg-muted",
				ghost: "text-muted-foreground not-disabled:hover:bg-muted not-disabled:hover:text-foreground",
				destructive:
					"border border-destructive/25 bg-destructive-surface text-destructive not-disabled:hover:bg-destructive/10",
			},
			size: {
				default: "px-3.5 py-2",
				sm: "px-2.5 py-1.5 text-xs",
				icon: "size-9",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export function Button({
	className,
	variant,
	size,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
	return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
