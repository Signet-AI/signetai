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
	mobileShell,
}: {
	onMenuClick: () => void;
	menuOpen: boolean;
	mobileShell: boolean;
}) {
	const { view, label } = useView();
	const { setOpen: setSettingsOpen } = useSettings();
	const platform = typeof navigator !== "undefined" ? detectPlatform() : "mac";

	return (
		<header
			className={cn(
				"sig-drag relative z-[60] flex h-[52px] shrink-0 items-center bg-transparent",
				mobileShell ? "gap-2 px-4" : "gap-3.5 px-6",
				platform !== "mac" && "pr-0",
			)}
		>
			{mobileShell && (
				<button
					type="button"
					onClick={onMenuClick}
					className="sig-no-drag grid size-11 touch-manipulation place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-controls="dashboard-navigation"
					aria-expanded={menuOpen}
					aria-label={menuOpen ? "Close navigation" : "Open navigation"}
				>
					<Menu className="size-4" />
				</button>
			)}
			<div className="sig-no-drag flex min-w-0 items-center gap-2 text-[13px]">
				<span className="shrink-0 text-muted-foreground">Signet /</span>
				<span className="truncate">{label(view)}</span>
			</div>
			<div className="flex-1" />
			<div
				className={cn(
					"sig-no-drag relative grid place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground",
					mobileShell ? "size-11" : "size-8",
				)}
				title="Notifications"
			>
				<Bell className="size-[17px]" />
				<span
					className={cn(
						"absolute size-1.5 rounded-full bg-primary",
						mobileShell ? "top-[11px] right-[11px]" : "top-[7px] right-[7px]",
					)}
				/>
			</div>
			{mobileShell && <ModeToggle className="!size-11 touch-manipulation" />}
			{mobileShell && (
				<button
					type="button"
					onClick={() => setSettingsOpen(true)}
					className="sig-no-drag grid size-11 touch-manipulation place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground"
					title="Settings"
					aria-label="Settings"
				>
					<Settings className="size-4" />
				</button>
			)}
			{platform !== "mac" && <CaptionButtons />}
		</header>
	);
}
