import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ModeToggle } from "@/components/mode-toggle";
import { Settings } from "@/components/mingcute-icons";
import { PanelIcon } from "@/components/shell/panel-icon";
import { type ViewId, useView } from "@/lib/view-context";
import { BookRegular, Home1Regular, MindMapRegular, MoonRegular } from "@mingcute/react/core-regular";
import { type ButtonHTMLAttributes, type ReactNode, useCallback, useEffect, useState } from "react";

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

const SIDEBAR_STORAGE_KEY = "signet-sidebar-open";

function readSidebarOpen(): boolean {
	try {
		return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

export function useSidebarOpen(): readonly [boolean, () => void] {
	const [open, setOpen] = useState(readSidebarOpen);
	const toggle = useCallback(() => setOpen((current) => !current), []);
	useEffect(() => {
		try {
			window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
		} catch {}
	}, [open]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
				return;
			if (isEditableTarget(event.target)) return;
			event.preventDefault();
			toggle();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle]);
	return [open, toggle] as const;
}

export function SidebarNav({ open }: { open: boolean }) {
	const { view, setView, openSettings } = useView();
	const activeView = view === "graph" || view === "memory" ? "memory" : view;
	return (
		<nav id="dashboard-sidebar" aria-label="Dashboard navigation" className="sig-sidebar">
			<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
				{TOP_LEVEL_NAV_ITEMS.map((item) => {
					const Icon = item.icon;
					const active = item.view === activeView;
					return (
						<li key={item.view}>
							<SidebarButton
								label={item.label}
								open={open}
								disabled={item.disabled}
								aria-current={active ? "page" : undefined}
								data-dashboard-nav={item.view}
								data-dashboard-nav-active={active ? "true" : undefined}
								onClick={() => setView(item.view)}
								className={active ? "is-active" : undefined}
							>
								<Icon className="size-[18px] shrink-0" />
							</SidebarButton>
						</li>
					);
				})}
			</ul>
			<div className="sig-no-drag mt-auto flex flex-col gap-0.5">
				<ModeToggle />
				<SidebarButton
					label="Settings"
					open={open}
					className={cn(view === "settings" && "is-active")}
					onClick={() => openSettings()}
					aria-current={view === "settings" ? "page" : undefined}
					data-dashboard-nav="settings"
				>
					<Settings className="size-[18px] shrink-0" aria-hidden="true" />
				</SidebarButton>
			</div>
		</nav>
	);
}

function SidebarButton({
	label,
	open,
	className,
	disabled,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; open: boolean }) {
	const button = (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			className={cn("sig-sidebar-link", className)}
			{...props}
		>
			{children}
			<span className="sig-sidebar-label" aria-hidden="true">
				{label}
				{disabled && <span className="sig-sidebar-soon">Soon</span>}
			</span>
		</button>
	);
	return (
		<Tooltip open={open ? false : undefined}>
			<TooltipTrigger asChild>{disabled ? <span className="flex w-full">{button}</span> : button}</TooltipTrigger>
			<TooltipContent side="right">
				{label}
				{disabled ? " · Coming soon" : ""}
			</TooltipContent>
		</Tooltip>
	);
}

export function ChatToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const label = open ? "Close chat" : "Open chat";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onToggle}
					aria-label={label}
					aria-expanded={open}
					className="sig-sidebar-toggle sig-chat-toggle sig-no-drag"
				>
					<PanelIcon side="right" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const label = open ? "Collapse sidebar" : "Expand sidebar";
	const shortcut = document.documentElement.dataset.platform === "mac" ? "⌘B" : "Ctrl+B";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onToggle}
					aria-label={label}
					aria-expanded={open}
					aria-controls="dashboard-sidebar"
					className="sig-sidebar-toggle sig-no-drag"
				>
					<PanelIcon side="left" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{label} · {shortcut}
			</TooltipContent>
		</Tooltip>
	);
}
