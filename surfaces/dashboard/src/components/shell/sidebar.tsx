import { SignetMark } from "@/components/icons";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings-context";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { type ViewId, useView } from "@/lib/view-context";
import type { ReactNode } from "react";

interface NavItem {
	view: ViewId;
	label: string;
	icon: (props: { className?: string }) => ReactNode;
	badge?: string;
	/** Disabled nav rows render greyed out, unselectable, with a "coming soon" tooltip. */
	disabled?: boolean;
}

/**
 * Nav glyphs lifted 1:1 from the locked mockup (16px, stroke 1.75) — lucide
 * generics don't match the spec's geometry, so these are inline SVGs.
 */
function navIcon(children: ReactNode) {
	return function NavGlyph({ className }: { className?: string }) {
		return (
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.75}
				strokeLinecap="round"
				strokeLinejoin="round"
				className={className}
			>
				{children}
			</svg>
		);
	};
}

const HomeIcon = navIcon(<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />);
const AgentsIcon = navIcon(
	<>
		<circle cx="12" cy="8" r="4" />
		<path d="M4 21v-1a6 6 0 0 1 12 0v1" />
	</>,
);
const MemoryIcon = navIcon(
	<>
		<circle cx="12" cy="12" r="3" />
		<circle cx="5" cy="5" r="2" />
		<circle cx="19" cy="5" r="2" />
		<circle cx="19" cy="19" r="2" />
		<circle cx="5" cy="19" r="2" />
		<path d="m6.5 6.5 3 3M17.5 6.5l-3 3M17.5 17.5l-3-3M6.5 17.5l3-3" />
	</>,
);
const SourcesIcon = navIcon(
	<>
		<path d="M9 2v6h6V2M5 2h14v20H5z" />
		<path d="M9 14h6M9 18h6" />
	</>,
);
const GraphIcon = navIcon(
	<>
		<circle cx="12" cy="5" r="2.5" />
		<circle cx="5" cy="18" r="2.5" />
		<circle cx="19" cy="18" r="2.5" />
		<path d="M12 7.5v4M12 11.5 6.7 16M12 11.5 17.3 16" />
	</>,
);
const DreamsIcon = navIcon(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />);
const SkillsIcon = navIcon(
	<>
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
	</>,
);
const SecretsIcon = navIcon(
	<>
		<rect x="3" y="11" width="18" height="11" rx="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</>,
);

const GROUPS: { label: string; items: NavItem[] }[] = [
	{
		label: "System",
		items: [
			{ view: "home", label: "Home", icon: HomeIcon },
			{ view: "agents", label: "Agents", icon: AgentsIcon, badge: "3", disabled: true },
		],
	},
	{
		label: "Focus",
		items: [
			{ view: "memory", label: "Memory", icon: MemoryIcon, badge: "8.1k" },
			{ view: "sources", label: "Sources", icon: SourcesIcon, badge: "4" },
		],
	},
	{
		label: "Knowledge engine",
		items: [
			{ view: "graph", label: "Graph", icon: GraphIcon, badge: "2.4k" },
			{ view: "dreaming", label: "Dreams", icon: DreamsIcon, badge: "14", disabled: true },
		],
	},
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
	const { view, setView } = useView();
	const graphStats = useAsync(() => api.getKnowledgeStats(), { intervalMs: 30_000 }).data;
	const secretsList = useAsync(() => api.getSecrets(), { intervalMs: 30_000 }).data;
	const status = useAsync(() => api.getStatus(), { intervalMs: 30_000 }).data;
	const agentCount = status?.agentId ? 1 : 0;
	const groups = GROUPS.map((group) => ({
		...group,
		items: group.items.map((item) => {
			if (item.view === "agents") {
				return { ...item, badge: agentCount ? String(agentCount) : undefined };
			}
			if (item.view === "graph") {
				return { ...item, badge: graphStats ? compactCount(graphStats.entityCount) : undefined };
			}
			return item;
		}),
	}));
	const navigate = (nextView: ViewId) => {
		setView(nextView);
		onNavigate?.();
	};

	return (
		<aside className="flex min-h-0 flex-1 flex-col bg-transparent text-sidebar-foreground">
			{/* Brand + workspace switcher */}
			<div className="flex items-stretch gap-0 border-b border-sidebar-border p-3">
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-[var(--radius)] border border-sidebar-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent hover:border-[color-mix(in_oklch,var(--foreground)_14%,transparent)]"
				>
					<SignetMark className="h-[22px] w-5 shrink-0" />
					<span className="flex flex-1 flex-col gap-px overflow-hidden leading-[1.15]">
						<span className="truncate text-sm leading-[1.15] font-semibold tracking-tight">Signet</span>
						<span className="truncate font-mono text-[10.5px] text-muted-foreground">Personal · {agentCount} agent{agentCount === 1 ? "" : "s"}</span>
					</span>
					<ChevronIcon className="size-[15px] shrink-0 text-muted-foreground" />
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto px-3 pb-3 pt-1.5">
				{groups.map((group) => (
					<div key={group.label} className="pt-2 first:pt-0 [&+&]:pt-5">
						<div className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground dark:text-[oklch(0.6_0_0)]">
							{group.label}
						</div>
						<ul className="flex flex-col gap-px">
							{group.items.map((item) => (
								<NavRow key={item.view} item={item} active={view === item.view} onClick={() => navigate(item.view)} />
							))}
						</ul>
					</div>
				))}
				{/* Assets group (secrets, skills) */}
				<div className="pt-5">
					<div className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground dark:text-[oklch(0.6_0_0)]">
						Assets
					</div>
					<ul className="flex flex-col gap-px">
						<NavRow
							item={{ view: "skills", label: "Skills", icon: SkillsIcon, badge: "120", disabled: true }}
							active={view === "skills"}
							onClick={() => navigate("skills")}
						/>
						<NavRow
							item={{
								view: "secrets",
								label: "Secrets",
								icon: SecretsIcon,
								badge: secretsList ? String(secretsList.secrets?.length ?? 0) : undefined,
							}}
							active={view === "secrets"}
							onClick={() => navigate("secrets")}
						/>
					</ul>
				</div>
			</nav>

			<AccountRow version={status?.version} />
		</aside>
	);
}

function compactCount(value: number): string {
	if (value < 1_000) return String(value);
	// Mockup badge format: one decimal ("2.4k", "8.1k").
	return `${(value / 1_000).toFixed(1)}k`;
}

function NavRow({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
	const { icon: Icon, disabled } = item;

	if (disabled) {
		return (
			<li>
				<Tooltip>
					<TooltipTrigger asChild>
						{/* A native `disabled` button suppresses pointer events, which would
						    also suppress the Radix tooltip trigger. The span carries the
						    pointer events; the button stays inert. */}
						<span className="flex w-full">
							<button
								type="button"
								disabled
								aria-disabled="true"
								className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[13px] text-muted-foreground/60 opacity-60 [html:not(.dark)_&]:text-muted-foreground/50"
							>
								<Icon className="size-4 shrink-0 text-current" />
								<span className="flex-1 text-left">{item.label}</span>
								{item.badge && <NavBadge active={false}>{item.badge}</NavBadge>}
							</button>
						</span>
					</TooltipTrigger>
					<TooltipContent side="right" sideOffset={8}>
						Coming soon
					</TooltipContent>
				</Tooltip>
			</li>
		);
	}

	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[13px] opacity-72 transition-[opacity,background,color] hover:opacity-100",
					active
						? "sig-surface bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] font-medium text-sidebar-foreground opacity-100"
						: "sig-nav-resting hover:bg-sidebar-accent hover:text-sidebar-foreground",
				)}
			>
				<Icon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-colors",
						active &&
							"text-sidebar-foreground drop-shadow-[0_0_6px_oklch(0.85_0_0/0.25)] [html:not(.dark)_&]:text-foreground [html:not(.dark)_&]:drop-shadow-[0_0_4px_oklch(0_0_0/0.1)]",
					)}
				/>
				<span className="flex-1 text-left">{item.label}</span>
				{item.badge && <NavBadge active={active}>{item.badge}</NavBadge>}
			</button>
		</li>
	);
}

function NavBadge({ children, active }: { children: React.ReactNode; active: boolean }) {
	// Muted mono counts — small and quiet so they never compete with the
	// section titles (tones removed per feedback).
	return (
		<span
			className={cn(
				"ml-[-4px] rounded px-1.5 py-0.5 font-mono text-[10px] leading-none",
				"bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-muted-foreground",
				active && "text-foreground/80",
			)}
		>
			{children}
		</span>
	);
}

function AccountRow({ version }: { version?: string }) {
	const { setOpen } = useSettings();
	// Flush against the sidebar's bottom edge — no floating card chrome,
	// just a hairline separator and the row itself.
	return (
		<div className="border-t border-sidebar-border px-3 py-2.5">
			<div className="flex items-center gap-2.5">
				<span className="flex flex-1 flex-col gap-px leading-tight">
					<span className="truncate text-[12.5px] font-medium text-sidebar-foreground">Signet</span>
					<span className="truncate font-mono text-[10px] text-muted-foreground">{version ? `v${version}` : "daemon running"}</span>
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
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="m7 9 5-5 5 5" />
			<path d="m7 15 5 5 5-5" />
		</svg>
	);
}
function SettingsIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}
