import type { ReactNode } from "react";

export function EmptyState({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="rounded-lg border border-dashed border-input px-6 py-10 text-center">
			<h3 className="text-sm font-medium text-foreground">{title}</h3>
			{children !== undefined && (
				<div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-[3px]">
					{children}
				</div>
			)}
		</div>
	);
}
