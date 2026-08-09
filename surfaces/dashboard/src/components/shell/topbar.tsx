import { ModeToggle } from "@/components/mode-toggle";
import { CaptionButtons } from "@/components/shell/window-chrome";
import { useSettings } from "@/lib/settings-context";
import { detectPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useView } from "@/lib/view-context";
import { Bell, Menu, Settings } from "lucide-react";

export function Topbar({
	onMenuClick,
	menuOpen,
}: {
	onMenuClick: () => void;
	menuOpen: boolean;
}) {
	const { view, label } = useView();
	const { setOpen: setSettingsOpen } = useSettings();
	const platform = typeof navigator !== "undefined" ? detectPlatform() : "mac";

	return (
		<header
			className={cn(
				"sig-drag relative z-[60] flex h-[52px] shrink-0 items-center gap-2 bg-transparent px-4 md:gap-3.5 md:px-6",
				platform !== "mac" && "pr-0",
			)}
		>
			<button
				type="button"
				onClick={onMenuClick}
				className="sig-no-drag grid size-11 touch-manipulation place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
				aria-controls="dashboard-navigation"
				aria-expanded={menuOpen}
				aria-label={menuOpen ? "Close navigation" : "Open navigation"}
			>
				<Menu className="size-4" />
			</button>
			<div className="sig-no-drag flex min-w-0 items-center gap-2 text-[13px]">
				<span className="shrink-0 text-muted-foreground">Signet /</span>
				<span className="truncate">{label(view)}</span>
			</div>
			<div className="flex-1" />
			<div
				className="sig-no-drag relative grid size-11 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground md:size-8"
				title="Notifications"
			>
				<Bell className="size-[17px]" />
				<span className="absolute top-[11px] right-[11px] size-1.5 rounded-full bg-primary md:top-[7px] md:right-[7px]" />
			</div>
			<ModeToggle className="!size-11 touch-manipulation md:hidden" />
			<button
				type="button"
				onClick={() => setSettingsOpen(true)}
				className="sig-no-drag grid size-11 touch-manipulation place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
				title="Settings"
				aria-label="Settings"
			>
				<Settings className="size-4" />
			</button>
			{platform !== "mac" && <CaptionButtons />}
		</header>
	);
}
