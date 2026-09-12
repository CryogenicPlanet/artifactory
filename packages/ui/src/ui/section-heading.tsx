import type { ReactNode } from "react";

export function SectionHeading({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="mb-4 flex items-center justify-between gap-4 [&>span]:text-[11px] [&>span]:text-subtle">
			<h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
			{children}
		</div>
	);
}
