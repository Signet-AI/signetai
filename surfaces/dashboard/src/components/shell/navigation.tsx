import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ModeToggle } from "@/components/mode-toggle";
import { type ViewId, useView } from "@/lib/view-context";
import { BookRegular, Home1Regular, MindMapRegular, MoonRegular } from "@mingcute/react/core-regular";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface NavItem {
	view: ViewId;
	label: string;
	icon: (props: { className?: string }) => ReactNode;
	disabled?: boolean;
}

export const TOP_LEVEL_NAV_ITEMS: NavItem[] = [
	{ view: "home", label: "Home", icon: Home1Regular },
	{ view: "memory", label: "Memory", icon: MindMapRegular },
	{ view: "dreaming", label: "Dreams", icon: MoonRegular },
	{ view: "skills", label: "Skills", icon: BookRegular, disabled: true },
];

export function SidebarNav() {
	const { view, setView, openSettings } = useView();
	const activeView = view === "graph" || view === "memory" ? "memory" : view;
	return (
		<nav aria-label="Dashboard navigation" className="sig-sidebar">
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{TOP_LEVEL_NAV_ITEMS.map((item) => {
					const Icon = item.icon;
					const active = item.view === activeView;
					return (
						<li key={item.view}>
							<SidebarButton
								label={item.label}
								disabled={item.disabled}
								aria-current={active ? "page" : undefined}
								data-dashboard-nav={item.view}
								data-dashboard-nav-active={active ? "true" : undefined}
								onClick={() => setView(item.view)}
								className={active ? "is-active" : undefined}
							>
								<Icon className="size-[22px] shrink-0" />
							</SidebarButton>
						</li>
					);
				})}
			</ul>
			<div className="sig-no-drag mt-auto flex flex-col gap-2">
				<ModeToggle />
				<SidebarButton
					label="Settings"
					className={cn(view === "settings" && "is-active")}
					onClick={() => openSettings()}
					aria-current={view === "settings" ? "page" : undefined}
					data-dashboard-nav="settings"
				>
					<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
						<circle cx="5" cy="12" r="1.7" />
						<circle cx="12" cy="12" r="1.7" />
						<circle cx="19" cy="12" r="1.7" />
					</svg>
				</SidebarButton>
			</div>
		</nav>
	);
}

function SidebarButton({
	label,
	className,
	disabled,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
	const button = (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			className={cn("sig-sidebar-link", className)}
			{...props}
		>
			{children}
		</button>
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>{disabled ? <span className="flex">{button}</span> : button}</TooltipTrigger>
			<TooltipContent side="right">
				{label}
				{disabled ? " · Coming soon" : ""}
			</TooltipContent>
		</Tooltip>
	);
}
