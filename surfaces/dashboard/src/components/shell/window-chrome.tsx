import { useEffect, useState } from "react";
import { detectPlatform, type Platform } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * Frameless window chrome. macOS reserves a sidebar titlebar strip so the
 * OS-rendered traffic lights clear the workspace switcher; Windows/Linux show
 * native caption buttons top-right. In a browser these are decorative.
 * `data-platform` on <html> drives the conditional CSS.
 */
function usePlatform(): Platform {
	const [p, setP] = useState<Platform>(() => detectPlatform());
	useEffect(() => {
		document.documentElement.setAttribute("data-platform", p);
	}, [p]);
	return p;
}

export function WindowChrome() {
	const platform = usePlatform();
	if (platform === "mac") {
		return (
			<div className="sig-drag flex h-[38px] shrink-0 items-center px-3.5">
				<div className="mt-[3px] flex items-center gap-2" title="Window controls">
					<span className="block h-3 w-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_oklch(0_0_0/0.25)]" />
					<span className="block h-3 w-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_oklch(0_0_0/0.25)]" />
					<span className="block h-3 w-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_oklch(0_0_0/0.25)]" />
				</div>
			</div>
		);
	}
	// win/linux: mockup reserves a slim 12px strip (`.sidebar__titlebar`)
	// so the sidebar rhythm matches across platforms; caption buttons
	// render in the topbar instead of dots here.
	return <div className="sig-drag h-[12px] shrink-0" />;
}

export function CaptionButtons() {
	// Only shown when data-platform is win/linux (handled by parent).
	return (
		<div className="sig-no-drag ml-2.5 flex items-center">
			<button
				type="button"
				aria-label="Minimize"
				className="grid h-[38px] w-[46px] place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<svg viewBox="0 0 12 12" width="11" height="11">
					<rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
				</svg>
			</button>
			<button
				type="button"
				aria-label="Maximize"
				className="grid h-[38px] w-[46px] place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1">
					<rect x="2.5" y="2.5" width="7" height="7" />
				</svg>
			</button>
			<button
				type="button"
				aria-label="Close"
				className={cn(
					"grid h-[38px] w-[46px] place-items-center text-muted-foreground",
					"hover:bg-[oklch(0.62_0.22_25)] hover:text-white",
				)}
			>
				<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2">
					<path d="m3 3 6 6M9 3l-6 6" />
				</svg>
			</button>
		</div>
	);
}
