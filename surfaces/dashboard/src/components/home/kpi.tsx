import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
					{index > 0 && <span className="home-status-sep mr-2 select-none text-muted-foreground/45">·</span>}
					<span className="text-muted-foreground/70">{label.toLowerCase()}</span>
					<span className="text-foreground">{value}</span>
					{trend && <span className="font-medium text-success">{trend}</span>}
					{sub && <span className="text-muted-foreground/65">{sub}</span>}
				</div>
			))}
		</footer>
	);
}

export interface DayBucket {
	date: string;
	count: number;
}
const HEATMAP_CELL_MIN = 12;
const HEATMAP_CELL_MAX = 22;
const HEATMAP_GAP = 3;
const HEATMAP_LEGEND = [0, 2, 4] as const;

export function ActivityHeatmap({ days, heading }: { days: DayBucket[]; heading?: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const total = Math.max(1, Math.ceil(days.length / 7));
	const [layout, setLayout] = useState<{ weeks: number; cell: number } | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const fit = () => {
			const width = element.clientWidth;
			if (width === 0) return;
			const fitted = Math.floor((width + HEATMAP_GAP) / (HEATMAP_CELL_MIN + HEATMAP_GAP));
			const weeks = Math.max(4, Math.min(total, fitted));
			const cell = Math.min(HEATMAP_CELL_MAX, Math.floor((width - HEATMAP_GAP * (weeks - 1)) / weeks));
			setLayout((current) => (current?.weeks === weeks && current.cell === cell ? current : { weeks, cell }));
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		return () => observer.disconnect();
	}, [total]);
	const weeks = layout?.weeks ?? total;
	const shown = days.slice(-weeks * 7);
	const gridWidth = layout ? layout.cell * weeks + HEATMAP_GAP * (weeks - 1) : undefined;
	const max = Math.max(1, ...shown.map((d) => d.count));
	const level = (n: number) => {
		if (n <= 0) return 0;
		const f = n / max;
		if (f > 0.75) return 4;
		if (f > 0.5) return 3;
		if (f > 0.25) return 2;
		return 1;
	};
	return (
		<div ref={ref} className="home-heatmap">
			<div className="flex max-w-full flex-col gap-2.5" style={{ width: gridWidth }}>
				<div className="flex items-center justify-between gap-3">
					{heading}
					<div className="flex items-center gap-1 text-meta tabular-nums text-muted-foreground">
						<span className="mr-0.5">Less</span>
						{HEATMAP_LEGEND.map((step) => (
							<span key={step} className={cn("size-2.5 rounded-[2px]", HEATMAP_LEVELS[step])} />
						))}
						<span className="ml-0.5">More</span>
					</div>
				</div>
				<div
					role="img"
					aria-label={`Memory activity, last ${weeks} weeks`}
					className="grid w-full"
					style={{
						gap: HEATMAP_GAP,
						gridTemplateRows: "repeat(7, auto)",
						gridAutoFlow: "column",
						gridAutoColumns: layout ? `${layout.cell}px` : "minmax(0, 1fr)",
					}}
				>
					{shown.map((d, i) => (
						<div
							key={i}
							title={`${d.date}: ${d.count}`}
							className={cn("aspect-square rounded-[3px] hover:brightness-110", HEATMAP_LEVELS[level(d.count)])}
						/>
					))}
				</div>
				<div className="flex justify-between text-meta tabular-nums text-muted-foreground">
					<span>{weeks}w ago</span>
					<span>{Math.round(weeks / 2)}w ago</span>
					<span>today</span>
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
