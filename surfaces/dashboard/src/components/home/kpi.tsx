import { useEffect, useState } from "react";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

export interface KpiData {
	label: string;
	value: string;
	sub?: string;
	trend?: string;
	/** Bounded fraction 0..1 — renders a small ring (agents/sources). */
	ring?: { value: number; sub: string };
	/** Unbounded stat — renders a live dot (memories/ontology). */
	live?: boolean;
}

export function KpiRow({ cards }: { cards: KpiData[] }) {
	return (
		<div className="grid shrink-0 grid-cols-2 gap-2.5 sm:grid-cols-4">
			{cards.map((c) => (
				<KpiCard key={c.label} {...c} />
			))}
		</div>
	);
}

function KpiCard({ label, value, sub, trend, ring, live }: KpiData) {
	return (
		<Surface className="px-3.25 py-2.75">
			<div className="mb-1.75 flex items-center justify-between gap-2">
				<span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
					{label}
				</span>
				{ring && <Ring fraction={ring.value} />}
				{live && (
					<span className="size-1.75 shrink-0 rounded-full bg-success shadow-[0_0_0_2px_color-mix(in_oklch,var(--success)_22%,transparent)]" />
				)}
			</div>
			<div className="font-mono text-[19px] font-medium leading-none tracking-tight text-foreground">
				{value}
			</div>
			{sub && (
				<div className="mt-1 text-[10.5px] text-muted-foreground">
					{trend && <span className="font-mono text-success">{trend}</span>} {sub}
				</div>
			)}
		</Surface>
	);
}

function Ring({ fraction }: { fraction: number }) {
	const r = 9;
	const c = 2 * Math.PI * r;
	const offset = c * (1 - Math.max(0, Math.min(1, fraction)));
	return (
		<svg viewBox="0 0 24 24" className="size-4.5 shrink-0">
			<circle
				cx="12"
				cy="12"
				r={r}
				fill="none"
				strokeWidth={3}
				stroke="color-mix(in oklch, var(--foreground) 16%, transparent)"
			/>
			<circle
				cx="12"
				cy="12"
				r={r}
				fill="none"
				strokeWidth={3}
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeDasharray={c}
				strokeDashoffset={offset}
				transform="rotate(-90 12 12)"
			/>
		</svg>
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
				aria-label="Memory activity, last 5 weeks"
				className="grid w-full gap-[3px]"
				style={{ gridTemplateRows: "repeat(7, 1fr)", gridAutoFlow: "column", gridAutoColumns: "1fr", aspectRatio: "36 / 7" }}
			>
				{days.map((d, i) => (
					<div
						key={i}
						title={`${d.date}: ${d.count}`}
						className={cn(
							"rounded-[2px] transition-transform hover:z-[1] hover:scale-[1.3] hover:outline hover:outline-1 hover:outline-foreground",
							HEATMAP_LEVELS[level(d.count)],
						)}
					/>
				))}
			</div>
			<div className="mt-1 flex items-center justify-between gap-3 font-mono text-[9px] text-muted-foreground">
				<div className="flex gap-3.5">
					<span>5w ago</span>
					<span>2w ago</span>
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
