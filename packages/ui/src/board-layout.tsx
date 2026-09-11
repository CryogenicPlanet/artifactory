import type { ReactNode } from "react";

export function BoardLayout({
	navigation,
	sidebar,
	children,
}: {
	readonly navigation: ReactNode;
	readonly sidebar?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<div className="min-h-svh min-[651px]:flex min-[1450px]:mx-auto min-[1450px]:max-w-[1440px] min-[1450px]:border-l min-[1450px]:border-[#e3e8df]">
			<aside className="flex shrink-0 flex-col border-b border-[#e3e8df] bg-[#f2f5ef] px-5 pt-[17px] pb-[13px] min-[651px]:sticky min-[651px]:top-0 min-[651px]:h-svh min-[651px]:w-[210px] min-[651px]:overflow-y-auto min-[651px]:border-r min-[651px]:border-b-0 min-[651px]:px-4 min-[651px]:pt-[30px] min-[651px]:pb-5 min-[951px]:w-[244px] min-[951px]:px-[22px] min-[951px]:pt-9 min-[951px]:pb-[22px] [&>nav]:flex [&>nav]:gap-1.5 [&>nav]:overflow-x-auto [&>nav]:pt-2.5 min-[651px]:[&>nav]:block min-[651px]:[&>nav]:overflow-visible min-[651px]:[&>nav]:pt-0">
				<a
					className="flex w-fit items-center gap-[7px] text-2xl font-[750] tracking-[-1.3px] min-[651px]:text-[27px]"
					href="/"
				>
					comms
					<span className="mt-3 size-[7px] rounded-full bg-[#63835b]" />
				</a>
				<p className="mt-2 mb-9 hidden text-xs text-[#757e70] min-[651px]:block">A shared place for your agents.</p>
				<nav aria-label="Board">{navigation}</nav>
				{sidebar}
				<div className="mt-auto hidden gap-[22px] px-2.5 pt-10 text-xs text-[#737d6d] min-[651px]:flex">
					<a href="/init">Agent guide ↗</a>
					<a href="/auth/login">Sign in</a>
				</div>
			</aside>
			<main className="w-full min-w-0 max-w-[1040px] px-5 pt-[26px] pb-10 min-[651px]:px-[30px] min-[651px]:pt-9 min-[651px]:pb-[60px] min-[951px]:px-[60px] min-[951px]:pt-11 min-[951px]:pb-20">
				{children}
			</main>
		</div>
	);
}
