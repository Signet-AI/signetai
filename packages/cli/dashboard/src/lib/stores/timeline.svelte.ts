/**
 * Timeline state management
 */

export interface TimeBucket {
	date: string;
	count: number;
	entities: Map<string, number>;
}

export interface EraMarker {
	id: string;
	label: string;
	startDate: string;
	endDate: string;
	color: string;
	description?: string;
}

export interface DateRange {
	start: string;
	end: string;
}

interface TimelineState {
	buckets: TimeBucket[];
	eras: EraMarker[];
	loading: boolean;
	selectedRange: DateRange;
	granularity: "day" | "week" | "month";
}

export const timeline = $state<TimelineState>({
	buckets: [],
	eras: [],
	loading: false,
	selectedRange: {
		start: getDefaultStart(),
		end: getDefaultEnd(),
	},
	granularity: "week",
});

function getDefaultEnd(): string {
	return new Date().toISOString().split("T")[0];
}

function getDefaultStart(): string {
	const date = new Date();
	date.setDate(date.getDate() - 90);
	return date.toISOString().split("T")[0];
}

export async function loadTimeline(): Promise<void> {
	timeline.loading = true;
	try {
		const params = new URLSearchParams({
			start: timeline.selectedRange.start,
			end: timeline.selectedRange.end,
			granularity: timeline.granularity,
		});

		const response = await fetch(`/api/timeline/range?${params}`);
		if (!response.ok) throw new Error("Failed to load timeline");

		const data = await response.json();
		timeline.buckets = data.buckets || [];
	} catch (error) {
		console.error("Failed to load timeline:", error);
		timeline.buckets = [];
	} finally {
		timeline.loading = false;
	}
}

export async function loadEras(): Promise<void> {
	try {
		const response = await fetch("/api/timeline/eras");
		if (!response.ok) throw new Error("Failed to load eras");

		const data = await response.json();
		timeline.eras = data.eras || [];
	} catch (error) {
		console.error("Failed to load eras:", error);
		timeline.eras = [];
	}
}

export async function detectEras(): Promise<void> {
	try {
		const response = await fetch("/api/timeline/eras/detect", {
			method: "POST",
		});
		if (!response.ok) throw new Error("Failed to detect eras");

		await loadEras();
	} catch (error) {
		console.error("Failed to detect eras:", error);
		throw error;
	}
}

export function setRange(start: string, end: string): void {
	timeline.selectedRange = { start, end };
}

export function setGranularity(granularity: "day" | "week" | "month"): void {
	timeline.granularity = granularity;
}
