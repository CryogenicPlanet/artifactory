import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../cn.ts";

const fieldClass =
	"w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground transition-colors placeholder:text-placeholder focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={cn(fieldClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={cn(fieldClass, "resize-y", className)} {...props} />;
}
