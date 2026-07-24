import { Menu, Bell } from "lucide-react";
import { CaptionButtons } from "@/components/shell/window-chrome";
import { useView } from "@/lib/view-context";
import { cn } from "@/lib/utils";
import { detectPlatform } from "@/lib/platform";

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
	const { view, label } = useView();
	const platform = typeof navigator !== "undefined" ? detectPlatform() : "mac";

	return (
		<header
			className={cn(
				"sig-drag flex h-[52px] shrink-0 items-center gap-3.5 bg-transparent px-6",
				platform !== "mac" && "pr-0",
			)}
		>
			<button
				type="button"
				onClick={onMenuClick}
				className="sig-no-drag grid size-8 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
				aria-label="Menu"
			>
				<Menu className="size-4" />
			</button>
			<div className="sig-no-drag flex items-center gap-2 text-[13px]">
				<span className="text-muted-foreground">Nicholai /</span>
				<span>{label(view)}</span>
			</div>
			<div className="flex-1" />
			<div
				className="sig-no-drag relative grid size-8 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground"
				title="Notifications"
			>
				<Bell className="size-[17px]" />
				<span className="absolute top-[7px] right-[7px] size-1.5 rounded-full bg-primary" />
			</div>
			<div className="sig-no-drag grid size-7.5 place-items-center rounded-full bg-gradient-to-br from-[oklch(0.6_0.02_270)] to-[oklch(0.35_0.02_270)] text-[12px] font-semibold text-white">
				NV
			</div>
			{platform !== "mac" && <CaptionButtons />}
		</header>
	);
}
