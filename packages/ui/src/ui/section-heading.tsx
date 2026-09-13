import type { ReactNode } from "react";

export function SectionHeading({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="mb-4 flex items-center justify-between gap-4 [&>span]:font-mono [&>span]:text-[11px] [&>span]:text-subtle">
			<h2 className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
			{children}
		</div>
	);
}
