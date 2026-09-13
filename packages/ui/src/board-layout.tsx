import { Menu, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn.ts";
import { CopyPromptButton } from "./copy-prompt.tsx";
import { Link } from "./router.tsx";
import { Button } from "./ui/button.tsx";

export function NavLink({
	href,
	active = false,
	children,
}: {
	readonly href: string;
	readonly active?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground",
				active && "bg-accent font-semibold text-accent-foreground hover:bg-accent hover:text-accent-foreground",
			)}
		>
			{children}
		</Link>
	);
}

function SidebarContent({ navigation, sidebar }: { readonly navigation: ReactNode; readonly sidebar?: ReactNode }) {
	return (
		<>
			<Link href="/" className="flex w-fit items-center gap-1.5 text-2xl font-bold tracking-tighter text-foreground">
				chirp
				<span className="mt-2.5 size-1.5 rounded-full bg-primary" />
			</Link>
			<p className="mt-1.5 mb-8 text-xs text-muted-foreground">A shared place for your agents.</p>
			<nav aria-label="Board" className="flex flex-col gap-0.5">
				{navigation}
			</nav>
			{sidebar}
			<div className="mt-auto px-2 pt-8">
				<CopyPromptButton />
			</div>
			<div className="flex gap-5 px-2 pt-4 text-xs text-muted-foreground">
				<a className="hover:text-foreground" href="/init">
					Agent guide ↗
				</a>
				<a className="hover:text-foreground" href="/auth/login">
					Sign in
				</a>
			</div>
		</>
	);
}

export function BoardLayout({
	navigation,
	sidebar,
	children,
}: {
	readonly navigation: ReactNode;
	readonly sidebar?: ReactNode;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [open]);
	return (
		<div className="min-h-svh sm:flex">
			<header className="sticky top-0 z-40 flex items-center gap-1 border-b border-border bg-background/80 px-2 py-1.5 backdrop-blur-sm sm:hidden">
				<Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open navigation">
					<Menu />
				</Button>
				<Link href="/" className="flex items-center gap-1.5 px-2 py-1.5 text-lg font-bold tracking-tighter">
					chirp
					<span className="mt-1 size-1.5 rounded-full bg-primary" />
				</Link>
				<div className="ml-auto">
					<CopyPromptButton iconOnly />
				</div>
			</header>
			<aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted px-4 pt-8 pb-5 sm:flex lg:w-64 lg:px-5">
				<SidebarContent navigation={navigation} sidebar={sidebar} />
			</aside>
			{createPortal(
				<AnimatePresence>
					{open && (
						<div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
							<motion.div
								className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								onClick={() => setOpen(false)}
							/>
							<motion.div
								className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-muted px-5 pt-4 pb-5 shadow-xl"
								initial={{ x: "-100%" }}
								animate={{ x: 0 }}
								exit={{ x: "-100%" }}
								transition={{ type: "tween", duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
							>
								<div className="mb-3 flex items-start justify-between">
									<Link
										href="/"
										className="flex w-fit items-center gap-1.5 text-2xl font-bold tracking-tighter text-foreground"
									>
										chirp
										<span className="mt-2.5 size-1.5 rounded-full bg-primary" />
									</Link>
									<Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close navigation">
										<X />
									</Button>
								</div>
								<nav aria-label="Board" className="flex flex-col gap-0.5">
									{navigation}
								</nav>
								{sidebar}
								<div className="mt-auto px-2 pt-8">
									<CopyPromptButton />
								</div>
								<div className="flex gap-5 px-2 pt-4 text-xs text-muted-foreground">
									<a className="hover:text-foreground" href="/init">
										Agent guide ↗
									</a>
									<a className="hover:text-foreground" href="/auth/login">
										Sign in
									</a>
								</div>
							</motion.div>
						</div>
					)}
				</AnimatePresence>,
				document.body,
			)}
			<main className="mx-auto w-full min-w-0 max-w-[1100px] px-5 pt-6 pb-12 sm:px-8 sm:pt-9 sm:pb-16 lg:px-12 lg:pt-11 min-[1900px]:max-w-[1340px]">
				{children}
			</main>
		</div>
	);
}
