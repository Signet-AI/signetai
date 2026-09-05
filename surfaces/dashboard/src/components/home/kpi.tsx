import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface KpiData {
	label: string;
	value: string;
	sub?: string;
	trend?: string;
}

export function KpiFooter({ cards }: { cards: KpiData[] }) {
	return (
		<footer className="home-status-bar" aria-label="System status">
			{cards.map(({ label, value, sub, trend }, index) => (
				<div key={label} className="flex min-w-0 items-baseline gap-x-1.5 whitespace-nowrap">
					{index > 0 && <span className="mr-2 select-none text-muted-foreground/45">·</span>}
					<span className="text-muted-foreground/70">{label.toLowerCase()}</span>
					<span className="text-foreground">{value}</span>
					{trend && <span className="font-medium text-success">{trend}</span>}
					{sub && <span className="text-muted-foreground/65">{sub}</span>}
				</div>
			))}
		</footer>
	);
}

/* ── Activity heatmap (GitHub-style) ── */

export interface DayBucket {
	date: string;
	count: number;
}

/**
 * Renders the last ~5 weeks as a 7-row × N-column heatmap. Levels bucket the
 * count into 5 bins; an empty cell is level 0. Mirrors the mockup's `.pc` grid.
 */
export function ActivityHeatmap({ days }: { days: DayBucket[] }) {
	const max = Math.max(1, ...days.map((d) => d.count));
	const level = (n: number) => {
		if (n <= 0) return 0;
		const f = n / max;
		if (f > 0.75) return 4;
		if (f > 0.5) return 3;
		if (f > 0.25) return 2;
		return 1;
	};
	return (
		<div className="flex flex-col gap-2">
			<div
				role="img"
				aria-label="Memory activity, last 36 weeks"
				className="grid w-full gap-[3px]"
				style={{
					gridTemplateRows: "repeat(7, auto)",
					gridAutoFlow: "column",
					gridAutoColumns: "1fr",
				}}
			>
				{days.map((d, i) => (
					<div
						key={i}
						title={`${d.date}: ${d.count}`}
						className={cn(
							"aspect-square rounded-[2px] hover:brightness-110",
							HEATMAP_LEVELS[level(d.count)],
						)}
					/>
				))}
			</div>
			<div className="flex shrink-0 items-center justify-between gap-3 font-mono text-[9px] text-muted-foreground">
				<div className="flex gap-3.5">
					<span>36w ago</span>
					<span>18w ago</span>
					<span>today</span>
				</div>
				<div className="flex items-center gap-1">
					<span>Less</span>
					<span className="size-2.25 rounded-[2px] bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)]" />
					<span className="size-2.25 rounded-[2px] bg-[color-mix(in_oklch,var(--success)_50%,transparent)]" />
					<span className="size-2.25 rounded-[2px] bg-success" />
					<span>More</span>
				</div>
			</div>
		</div>
	);
}

const HEATMAP_LEVELS = [
	"bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)]",
	"bg-[color-mix(in_oklch,var(--success)_28%,transparent)]",
	"bg-[color-mix(in_oklch,var(--success)_50%,transparent)]",
	"bg-[color-mix(in_oklch,var(--success)_72%,transparent)]",
	"bg-success",
];

/** Client-side date string; avoids hydration mismatches in the static export. */
export function useDateString(localeDate: string): string {
	const [s, setS] = useState(localeDate);
	useEffect(() => {
		setS(
			new Date().toLocaleDateString("en-US", {
				weekday: "long",
				month: "long",
				day: "numeric",
			}),
		);
	}, [localeDate]);
	return s;
}
