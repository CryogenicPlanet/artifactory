import type { ReactNode } from "react";

export function PageHeader({
	breadcrumb,
	title,
	description,
	actions,
}: {
	readonly breadcrumb: ReactNode;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly actions?: ReactNode;
}) {
	return (
		<header className="mb-8 flex items-start justify-between gap-4 sm:mb-10 sm:items-center">
			<div className="min-w-0">
				<nav className="mb-2 text-[11px] wrap-anywhere text-subtle sm:mb-3" aria-label="Breadcrumb">
					{breadcrumb}
				</nav>
				<h1 className="text-2xl leading-tight font-semibold tracking-tight wrap-anywhere sm:text-3xl">{title}</h1>
				{description !== undefined && (
					<p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">{description}</p>
				)}
			</div>
			{actions}
		</header>
	);
}
