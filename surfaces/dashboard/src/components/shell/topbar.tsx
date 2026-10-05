import { useSyncExternalStore } from "react";
import { dashboardQueryCache } from "@/lib/query-cache";
import { SignetMark } from "@/components/icons";
import { getDesktopBridge } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { useView } from "@/lib/view-context";
import { SidebarToggle } from "@/components/shell/navigation";

export function Topbar({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
	const desktop = getDesktopBridge();
	const unavailable = useSyncExternalStore(
		dashboardQueryCache.subscribeStatus,
		dashboardQueryCache.unavailableReads,
		() => 0,
	);
	const { view, label } = useView();

	return (
		<header className={cn("relative z-40 flex shrink-0 flex-col bg-background", desktop !== null && "sig-drag")}>
			<div className="sig-topbar-row relative flex h-[32px] shrink-0 items-center px-4 sm:px-6">
				{unavailable > 0 && (
					<span role="status" className="ml-auto hidden text-[10px] text-muted-foreground sm:block">
						Updates unavailable
					</span>
				)}
				<SignetMark className="sig-topbar-brand" aria-label="Signet" aria-hidden={false} role="img" />
				<SidebarToggle open={sidebarOpen} onToggle={onToggleSidebar} />
				<div className="sig-no-drag absolute left-1/2 flex max-w-[calc(100%_-_112px)] min-w-0 -translate-x-1/2 items-center gap-1.5">
					<SignetMark className="sig-topbar-title-mark h-[19px] w-4 shrink-0" aria-hidden="true" />
					<span className="truncate text-[16px] font-medium tracking-tight">{label(view)}</span>
				</div>
			</div>
		</header>
	);
}
