import { useSyncExternalStore } from "react";
import { dashboardQueryCache } from "@/lib/query-cache";
import { SignetMark } from "@/components/icons";
import { AgentContextSwitcher } from "@/components/shell/agent-switcher";
import { SessionChip } from "@/components/shell/sign-in";
import { getDesktopBridge } from "@/lib/desktop";
import { useSession, useWhoami } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useView } from "@/lib/view-context";
import { ChatToggle, SidebarToggle } from "@/components/shell/navigation";

export function TopbarTitle({ label, organization }: { readonly label: string; readonly organization: boolean }) {
	return (
		<div
			className={cn(
				"sig-no-drag absolute left-1/2 flex min-w-0 -translate-x-1/2 items-center gap-1.5",
				organization ? "max-w-12 sm:max-w-[calc(100%_-_560px)]" : "max-w-[calc(100%_-_112px)]",
			)}
		>
			<SignetMark className="sig-topbar-title-mark h-[19px] w-4 shrink-0" aria-hidden="true" />
			<span className="truncate text-[16px] font-medium tracking-tight">{label}</span>
		</div>
	);
}

export function UpdateAvailability({
	count,
	organizationRole,
}: {
	readonly count: number;
	readonly organizationRole?: string;
}) {
	return count > 0 && (organizationRole === undefined || organizationRole === "admin") ? (
		<span role="status" className="hidden text-[10px] text-muted-foreground sm:block">
			Updates unavailable
		</span>
	) : null;
}

export function Topbar({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
	const desktop = getDesktopBridge();
	const unavailable = useSyncExternalStore(
		dashboardQueryCache.subscribeStatus,
		dashboardQueryCache.unavailableReads,
		() => 0,
	);
	const { view, label, chatOpen, setChatOpen } = useView();
	const chatAvailable = view === "graph";
	const session = useSession();
	const whoami = useWhoami();
	const organization = whoami !== null;

	return (
		<header className={cn("relative z-40 flex shrink-0 flex-col bg-background", desktop !== null && "sig-drag")}>
			<div
				className={cn(
					"sig-topbar-row relative flex shrink-0 items-center px-4 sm:px-6",
					organization ? "h-11 w-full" : "h-[32px]",
				)}
			>
				<SignetMark className="sig-topbar-brand" aria-label="Signet" aria-hidden={false} role="img" />
				<SidebarToggle open={sidebarOpen} onToggle={onToggleSidebar} />
				<TopbarTitle label={label(view)} organization={organization} />
				<div
					className={cn(
						"sig-no-drag relative z-10 ml-auto flex items-center gap-3",
						organization && "min-w-0 justify-end gap-2 sm:gap-3",
						organization && (chatAvailable ? "w-[calc(50%_-_88px)]" : "w-[calc(50%_-_56px)]"),
						chatAvailable && "mr-9",
					)}
				>
					<UpdateAvailability count={unavailable} organizationRole={whoami?.user.role} />
					<AgentContextSwitcher />
					<SessionChip session={session} />
				</div>
				{chatAvailable && <ChatToggle open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />}
			</div>
		</header>
	);
}
