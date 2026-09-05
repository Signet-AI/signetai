import { useState } from "react";
import { SignetMark } from "@/components/icons";
import { ModeToggle } from "@/components/mode-toggle";
import { HeaderNav } from "@/components/shell/navigation";
import { CaptionButtons } from "@/components/shell/window-chrome";
import { Button } from "@/components/ui/button";
import { detectPlatform } from "@/lib/platform";
import { useSettings } from "@/lib/settings-context";
import { cn } from "@/lib/utils";
import { Menu, Settings, X } from "@/components/mingcute-icons";

export function Topbar() {
	const platform = typeof navigator !== "undefined" ? detectPlatform() : "mac";
	const [mobileOpen, setMobileOpen] = useState(false);
	const { setOpen } = useSettings();

	return (
		<header
			className={cn(
				"sig-drag relative flex h-[56px] shrink-0 items-center border-b border-border/70 bg-background px-4 sm:px-6",
				platform !== "mac" && "pr-0",
			)}
		>
			<button
				type="button"
				onClick={() => setMobileOpen((open) => !open)}
				className="sig-no-drag grid size-8 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
				aria-label="Menu"
				aria-expanded={mobileOpen}
			>
				{mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
			</button>

			<div className="sig-no-drag flex min-w-0 items-center gap-2.5">
				<SignetMark className="h-7 w-6 shrink-0" />
				<span className="text-[20px] font-medium tracking-tight">Signet</span>
			</div>

			<div className="sig-no-drag ml-12 hidden md:block">
				<HeaderNav />
			</div>

			<div className="sig-no-drag ml-auto flex items-center gap-px">
				<ModeToggle />
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setOpen(true)}
					title="Settings"
					aria-label="Settings"
					className="sig-header-control size-[26px] rounded-[var(--radius)]"
				>
					<Settings className="size-3.5" />
				</Button>
				{platform !== "mac" && <CaptionButtons />}
			</div>

			{mobileOpen && (
				<div className="sig-no-drag absolute left-4 right-4 top-[52px] z-30 rounded-[12px] border border-border/70 bg-card p-1.5 shadow-[0_12px_30px_oklch(0_0_0/0.22)] md:hidden">
					<HeaderNav mobile onNavigate={() => setMobileOpen(false)} />
				</div>
			)}
		</header>
	);
}
