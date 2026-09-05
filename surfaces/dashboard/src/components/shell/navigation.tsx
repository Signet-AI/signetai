import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type ViewId, useView } from "@/lib/view-context";
import { BookRegular, GitBranchRegular, Home1Regular, MindMapRegular, MoonRegular } from "@mingcute/react/core-regular";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface NavItem {
	view: ViewId;
	label: string;
	icon: (props: { className?: string }) => ReactNode;
	/** Disabled nav items remain visible as a quiet affordance for future views. */
	disabled?: boolean;
}

const HomeIcon = Home1Regular;
const MemoryIcon = MindMapRegular;
const GraphIcon = GitBranchRegular;
const DreamsIcon = MoonRegular;
const SkillsIcon = BookRegular;

export const TOP_LEVEL_NAV_ITEMS: NavItem[] = [
	{ view: "home", label: "Home", icon: HomeIcon },
	{ view: "memory", label: "Memory", icon: MemoryIcon },
	{ view: "skills", label: "Skills", icon: SkillsIcon, disabled: true },
];

export const MEMORY_NAV_ITEMS: NavItem[] = [
	{ view: "graph", label: "Graph", icon: GraphIcon },
	{ view: "dreaming", label: "Dreams", icon: DreamsIcon },
];

const MEMORY_VIEWS: ViewId[] = ["memory", "graph", "dreaming"];

export function HeaderNav({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
	const { view, setView } = useView();
	const activeView = MEMORY_VIEWS.includes(view) ? "memory" : view;
	const navRef = useRef<HTMLUListElement>(null);
	const [indicator, setIndicator] = useState({ left: 0, width: 0 });

	useLayoutEffect(() => {
		if (mobile) return;
		const nav = navRef.current;
		if (!nav) return;
		const measure = () => {
			const active = nav.querySelector<HTMLElement>(`[data-dashboard-nav="${activeView}"]`);
			if (!active) return;
			const navRect = nav.getBoundingClientRect();
			const activeRect = active.getBoundingClientRect();
			setIndicator({ left: activeRect.left - navRect.left, width: activeRect.width });
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(nav);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [activeView, mobile]);

	return (
		<nav aria-label="Dashboard navigation" className={cn(mobile ? "w-full" : "relative flex items-center")}>
			<ul
				ref={navRef}
				className={cn("m-0 list-none", mobile ? "flex flex-col gap-0.5" : "relative flex items-center gap-1")}
			>
				{!mobile && (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 z-0 rounded-full bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] transition-[transform,width] duration-200 ease-out"
						style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
					/>
				)}
				{TOP_LEVEL_NAV_ITEMS.map((item) => (
					<li key={item.view}>
						<HeaderNavItem
							item={item}
							active={item.view === activeView}
							mobile={mobile}
							onClick={() => {
								setView(item.view === "memory" ? "graph" : item.view);
								onNavigate?.();
							}}
						/>
					</li>
				))}
			</ul>
		</nav>
	);
}

export function MemoryNav() {
	const { view, setView } = useView();

	return (
		<nav aria-label="Memory views" className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60">
			{MEMORY_NAV_ITEMS.map((item) => {
				const Icon = item.icon;
				const active = view === item.view;
				return (
					<button
						type="button"
						key={item.view}
						onClick={() => setView(item.view)}
						aria-current={active ? "page" : undefined}
						className={cn(
							"sig-no-drag inline-flex h-7 items-center gap-1.5 rounded-[var(--radius)] px-2 text-[11px] transition-colors",
							active
								? "bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] font-medium text-foreground"
								: "text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] hover:text-foreground",
						)}
					>
						<Icon className={cn("size-3.5", active ? "text-foreground" : "text-muted-foreground")} />
						{item.label}
					</button>
				);
			})}
		</nav>
	);
}

function HeaderNavItem({
	item,
	active,
	mobile,
	onClick,
}: {
	item: NavItem;
	active: boolean;
	mobile: boolean;
	onClick: () => void;
}) {
	const { icon: Icon, disabled } = item;
	const button = (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-current={active ? "page" : undefined}
			aria-disabled={disabled ? true : undefined}
			data-dashboard-nav={item.view}
			data-dashboard-nav-active={active ? "true" : undefined}
			className={cn(
				"sig-no-drag relative z-10 flex items-center gap-2 px-2 text-[12px] transition-[color,opacity] duration-180",
				mobile ? "w-full rounded-[var(--radius)] py-1.5" : "h-9 shrink-0 justify-center rounded-full px-3",
				disabled
					? "cursor-not-allowed text-muted-foreground/45"
					: active
						? mobile
							? "bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] font-medium text-foreground"
							: "font-medium text-foreground"
						: "text-muted-foreground hover:text-foreground",
			)}
		>
			<Icon className={cn("size-3.5 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
			<span className="text-left">{item.label}</span>
		</button>
	);

	if (!disabled) return button;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="flex">{button}</span>
			</TooltipTrigger>
			<TooltipContent side={mobile ? "right" : "bottom"} sideOffset={8}>
				Coming soon
			</TooltipContent>
		</Tooltip>
	);
}
