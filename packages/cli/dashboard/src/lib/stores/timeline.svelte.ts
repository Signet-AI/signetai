/**
 * Timeline state management
 */

export interface TimeBucket {
	bucket: string;
	memory_count: number;
	top_entities: Array<{ name: string; mention_count: number }>;
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
	const isoString = date.toISOString();
	return isoString.split("T")[0] || new Date().toISOString().split("T")[0];
}

// Color palette for era types
const ERA_COLORS: Record<string, string> = {
	project: "#3b82f6",
	topic: "#10b981",
	workflow: "#f59e0b",
	transition: "#6366f1",
};

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
		// Transform backend format to frontend format
		timeline.eras = (data.eras || []).map((era: any) => ({
			id: era.id,
			label: era.name,
			startDate: era.start_date,
			endDate: era.end_date,
			color: ERA_COLORS[era.era_type] || "#6b7280",
			description: era.top_entities
				? `Top entities: ${JSON.parse(era.top_entities).join(", ")}`
				: undefined,
		}));
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
