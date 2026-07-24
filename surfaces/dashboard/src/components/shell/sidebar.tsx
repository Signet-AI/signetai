import {
	Brain,
	BookOpen,
	Share2,
	Moon,
	SquareTerminal,
	Lock,
	Home,

	type LucideIcon,
} from "lucide-react";
import { SignetMark } from "@/components/icons";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { useView, type ViewId } from "@/lib/view-context";
import { useSettings } from "@/lib/settings-context";
import { cn } from "@/lib/utils";

interface NavItem {
	view: ViewId;
	label: string;
	icon: LucideIcon;
	badge?: string;
	badgeTone?: "green" | "amber";
}

const GROUPS: { label: string; items: NavItem[] }[] = [
	{ label: "System", items: [{ view: "home", label: "Home", icon: Home }] },
	{
		label: "Focus",
		items: [
			{ view: "memory", label: "Memory", icon: Brain },
			{ view: "sources", label: "Sources", icon: BookOpen },
		],
	},
	{
		label: "Knowledge engine",
		items: [
			{ view: "graph", label: "Graph", icon: Share2 },
			{ view: "dreaming", label: "Dreams", icon: Moon },
		],
	},
];

export function Sidebar() {
	const { view, setView } = useView();

	return (
		<aside className="flex h-full flex-col bg-transparent text-sidebar-foreground">
			{/* Brand + workspace switcher */}
			<div className="flex items-stretch gap-0 border-b border-sidebar-border p-3">
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-[var(--radius)] border border-sidebar-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent hover:border-[color-mix(in_oklch,var(--foreground)_14%,transparent)]"
				>
					<SignetMark className="size-5 shrink-0" />
					<span className="flex flex-1 flex-col gap-px overflow-hidden leading-tight">
						<span className="truncate text-sm font-semibold tracking-tight">Signet</span>
						<span className="truncate font-mono text-[10.5px] text-muted-foreground">
							Personal · 3 agents
						</span>
					</span>
					<ChevronIcon className="size-3.5 shrink-0 text-muted-foreground" />
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto px-3 pb-3 pt-1.5">
				{GROUPS.map((group) => (
					<div key={group.label} className="pt-2 first:pt-0 [&+&]:pt-5">
						<div className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[oklch(0.42_0_0)] dark:text-[oklch(0.6_0_0)]">
							{group.label}
						</div>
						<ul className="flex flex-col gap-px">
							{group.items.map((item) => (
								<NavRow key={item.view} item={item} active={view === item.view} onClick={() => setView(item.view)} />
							))}
						</ul>
					</div>
				))}
				{/* Assets group (secrets, skills) */}
				<div className="pt-5">
					<div className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[oklch(0.42_0_0)] dark:text-[oklch(0.6_0_0)]">
						Assets
					</div>
					<ul className="flex flex-col gap-px">
						<NavRow
							item={{ view: "skills", label: "Skills", icon: SquareTerminal, badge: "120", badgeTone: "green" }}
							active={view === "skills"}
							onClick={() => setView("skills")}
						/>
						<NavRow
							item={{ view: "secrets", label: "Secrets", icon: Lock, badge: "12", badgeTone: "amber" }}
							active={view === "secrets"}
							onClick={() => setView("secrets")}
						/>
					</ul>
				</div>
			</nav>

			<AccountRow />
		</aside>
	);
}

function NavRow({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
	const { icon: Icon } = item;
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[13px] opacity-72 transition-opacity hover:opacity-100",
					active
						? "sig-nav-active font-medium text-sidebar-foreground opacity-100 ring-1"
						: "sig-nav-resting hover:bg-sidebar-accent hover:text-sidebar-foreground",
				)}
			>
				<Icon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-colors",
						active && "sig-nav-icon-active",
					)}
				/>
				<span className="flex-1 text-left">{item.label}</span>
				{item.badge && (
					<NavBadge tone={item.badgeTone} active={active}>
						{item.badge}
					</NavBadge>
				)}
			</button>
		</li>
	);
}

function NavBadge({
	children,
	tone,
	active,
}: {
	children: React.ReactNode;
	tone?: "green" | "amber";
	active: boolean;
}) {
	return (
		<span
			className={cn(
				"ml-[-4px] rounded px-1.5 py-0.5 font-mono text-[9.5px] font-medium leading-none ring-1 shadow-[inset_0_-1px_0_oklch(0_0_0/0.2)]",
				active
					? "bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] text-sidebar-foreground ring-[oklch(1_0_0/0.14)]"
					: "bg-[var(--hover-overlay)] text-muted-foreground ring-[oklch(1_0_0/0.08)]",
				tone === "green" &&
					"bg-[color-mix(in_oklch,var(--success)_16%,transparent)] text-[oklch(0.82_0.16_150)] ring-[color-mix(in_oklch,var(--success)_30%,transparent)] shadow-[inset_0_-1px_0_oklch(0_0_0/0.15)]",
				tone === "amber" &&
					"bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] text-[oklch(0.82_0.14_75)] ring-[color-mix(in_oklch,var(--warning)_30%,transparent)] shadow-[inset_0_-1px_0_oklch(0_0_0/0.15)]",
			)}
		>
			{children}
		</span>
	);
}

function AccountRow() {
	const { setOpen } = useSettings();
	return (
		<div className="flex flex-col gap-2.5 px-3 pb-3 pt-2.5">
			<div className="flex items-center gap-2.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.05)] bg-card px-2 py-1.75 shadow-[inset_0_1px_0_oklch(1_0_0/0.04)]">
				<span className="relative grid size-6.5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[oklch(0.6_0.02_270)] to-[oklch(0.35_0.02_270)] text-[11px] font-semibold text-white">
					NV
					<span className="absolute -bottom-px -right-px size-2 rounded-full border-2 border-card bg-success [animation:health-pulse_2.4s_ease-in-out_infinite]" />
				</span>
				<span className="flex flex-1 flex-col gap-px leading-tight">
					<span className="truncate text-[12.5px] font-medium text-sidebar-foreground">Nicholai</span>
					<span className="truncate font-mono text-[10px] text-muted-foreground">daemon running</span>
				</span>
				<span className="flex shrink-0 items-center gap-px">
					<ModeToggle />
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setOpen(true)}
						title="Settings"
						aria-label="Settings"
						className="size-[26px] rounded-[var(--radius)]"
					>
						<SettingsIcon className="size-3.5" />
					</Button>
				</span>
			</div>
		</div>
	);
}

/* ── inline icons (mockup uses custom strokes) ── */
function ChevronIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
			<path d="m7 9 5-5 5 5" />
			<path d="m7 15 5 5 5-5" />
		</svg>
	);
}
function SettingsIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}


