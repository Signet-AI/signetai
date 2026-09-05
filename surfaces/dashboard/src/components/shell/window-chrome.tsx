import { cn } from "@/lib/utils";

export function CaptionButtons() {
	return (
		<div className="sig-no-drag ml-2.5 flex items-center">
			<button
				type="button"
				aria-label="Minimize"
				className="sig-header-control grid h-[38px] w-[46px] place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<svg viewBox="0 0 12 12" width="11" height="11">
					<rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
				</svg>
			</button>
			<button
				type="button"
				aria-label="Maximize"
				className="sig-header-control grid h-[38px] w-[46px] place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1">
					<rect x="2.5" y="2.5" width="7" height="7" />
				</svg>
			</button>
			<button
				type="button"
				aria-label="Close"
				className={cn(
					"sig-header-control grid h-[38px] w-[46px] place-items-center text-muted-foreground",
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
