import type { ReadDb } from "./db-accessor";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const EVOLVED_EVENTS = new Set(["updated", "merged", "recovered"]);
const STRENGTHENED_REASON_PATTERN =
	/(reinfor|strength|consolidat|stabiliz|promot|confidence|refin)/i;

interface MemoryRow {
	readonly id: string;
	readonly created_at: string;
	readonly type: string | null;
	readonly who: string | null;
	readonly tags: string | null;
	readonly importance: number | null;
	readonly pinned: number | null;
}

interface HistoryRow {
	readonly memory_id: string;
	readonly event: string;
	readonly reason: string | null;
	readonly created_at: string;
}

interface RangeSpec {
	readonly eraIndex: number;
	readonly key: "today" | "last_week" | "one_month";
	readonly label: "Today" | "Last week" | "One month";
	/** Number of days the range spans, starting from "today" and going back */
	readonly lookbackDays: number;
}

const RANGE_SPECS: readonly RangeSpec[] = [
	{
		eraIndex: 0,
		key: "today",
		label: "Today",
		lookbackDays: 1,
	},
	{
		eraIndex: 1,
		key: "last_week",
		label: "Last week",
		lookbackDays: 7,
	},
	{
		eraIndex: 2,
		key: "one_month",
		label: "One month",
		lookbackDays: 30,
	},
] as const;

export interface TimelineMetric {
	readonly key: string;
	readonly count: number;
}

export interface MemoryTimelineBucket {
	readonly eraIndex: number;
	readonly rangeKey: "today" | "last_week" | "one_month";
	readonly label: "Today" | "Last week" | "One month";
	readonly start: string;
	readonly end: string;
	readonly memoriesAdded: number;
	readonly trackedEvents: number;
	readonly evolved: number;
	readonly strengthened: number;
	readonly recovered: number;
	readonly avgImportance: number;
	readonly pinned: number;
	readonly typeBreakdown: readonly TimelineMetric[];
	readonly sourceBreakdown: readonly TimelineMetric[];
	readonly topTags: readonly TimelineMetric[];
}

export interface MemoryTimelineResponse {
	readonly generatedAt: string;
	readonly generatedFor: string;
	readonly rangePreset: "today-last_week-one_month";
	readonly totalMemories: number;
	readonly totalHistoryEvents: number;
	readonly invalidMemoryTimestamps: number;
	readonly invalidHistoryTimestamps: number;
	readonly buckets: readonly MemoryTimelineBucket[];
}

interface MutableBucket {
	readonly spec: RangeSpec;
	readonly startMs: number;
	readonly endMs: number;
	totalImportance: number;
	importanceSamples: number;
	memoriesAdded: number;
	trackedEvents: number;
	evolved: number;
	strengthened: number;
	recovered: number;
	pinned: number;
	readonly typeBreakdown: Map<string, number>;
	readonly sourceBreakdown: Map<string, number>;
	readonly topTags: Map<string, number>;
}

/**
 * Start of day in the caller's timezone.
 * @param ms - current timestamp
 * @param tzOffsetMin - minutes west of UTC (same as Date.getTimezoneOffset(),
 *   e.g. 420 for MST/UTC-7). Defaults to 0 (UTC).
 */
function startOfLocalDay(ms: number, tzOffsetMin = 0): number {
	const local = ms - tzOffsetMin * 60_000;
	const d = new Date(local);
	const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	return dayStart + tzOffsetMin * 60_000;
}

function parseTimestamp(raw: string): number | null {
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

function rangeBounds(spec: RangeSpec, nowStartMs: number): {
	startMs: number;
	endMs: number;
} {
	const startMs = nowStartMs - (spec.lookbackDays - 1) * MS_PER_DAY;
	const endMs = nowStartMs + MS_PER_DAY - 1;
	return { startMs, endMs };
}

function createBuckets(nowStartMs: number): Map<RangeSpec["eraIndex"], MutableBucket> {
	const buckets = new Map<RangeSpec["eraIndex"], MutableBucket>();
	for (const spec of RANGE_SPECS) {
		const { startMs, endMs } = rangeBounds(spec, nowStartMs);
		buckets.set(spec.eraIndex, {
			spec,
			startMs,
			endMs,
			totalImportance: 0,
			importanceSamples: 0,
			memoriesAdded: 0,
			trackedEvents: 0,
			evolved: 0,
			strengthened: 0,
			recovered: 0,
			pinned: 0,
			typeBreakdown: new Map<string, number>(),
			sourceBreakdown: new Map<string, number>(),
			topTags: new Map<string, number>(),
		});
	}
	return buckets;
}

function forEachMatchingBucket(
	timestampMs: number,
	buckets: Map<RangeSpec["eraIndex"], MutableBucket>,
	cb: (bucket: MutableBucket) => void,
): boolean {
	let matched = false;
	for (const spec of RANGE_SPECS) {
		const bucket = buckets.get(spec.eraIndex);
		if (!bucket) continue;
		if (timestampMs >= bucket.startMs && timestampMs <= bucket.endMs) {
			matched = true;
			cb(bucket);
		}
	}
	return matched;
}

function incMap(target: Map<string, number>, key: string): void {
	target.set(key, (target.get(key) ?? 0) + 1);
}

function normalizeMetricKey(
	raw: string | null | undefined,
	fallback: string,
): string {
	const trimmed = raw?.trim();
	if (!trimmed) return fallback;
	return trimmed;
}

function parseTags(raw: string | null): string[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (!trimmed) return [];

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed
					.filter((tag) => typeof tag === "string")
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 0);
			}
		} catch {
			// fall through to csv parsing
		}
	}

	return trimmed
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

function sortMetrics(map: Map<string, number>, limit = 5): TimelineMetric[] {
	return [...map.entries()]
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0]);
		})
		.slice(0, limit)
		.map(([key, count]) => ({ key, count }));
}

export function buildMemoryTimeline(
	db: ReadDb,
	options?: {
		readonly now?: Date;
		/** Minutes west of UTC (Date.getTimezoneOffset()). Defaults to 0. */
		readonly tzOffsetMin?: number;
	},
): MemoryTimelineResponse {
	const now = options?.now ?? new Date();
	const tzOffsetMin = options?.tzOffsetMin ?? 0;
	const nowStartMs = startOfLocalDay(now.getTime(), tzOffsetMin);
	const buckets = createBuckets(nowStartMs);

	// Widest bucket is 30 days — filter SQL to avoid full table scan
	const cutoffMs = nowStartMs - 29 * MS_PER_DAY;
	const cutoffIso = new Date(cutoffMs).toISOString();

	const memoryRows = db
		.prepare(
			`SELECT id, created_at, type, who, tags, importance, pinned
			 FROM memories
			 WHERE is_deleted = 0
			   AND created_at >= ?
			 ORDER BY created_at DESC`,
		)
		.all(cutoffIso) as MemoryRow[];

	const historyRows = db
		.prepare(
			`SELECT h.memory_id, h.event, h.reason, h.created_at
			 FROM memory_history h
			 INNER JOIN memories m ON m.id = h.memory_id
			 WHERE m.is_deleted = 0
			   AND h.created_at >= ?
			 ORDER BY h.created_at DESC`,
		)
		.all(cutoffIso) as HistoryRow[];

	let invalidMemoryTimestamps = 0;
	let invalidHistoryTimestamps = 0;

	for (const row of memoryRows) {
		const ts = parseTimestamp(row.created_at);
		if (ts === null) {
			invalidMemoryTimestamps += 1;
			continue;
		}

		forEachMatchingBucket(ts, buckets, (bucket) => {
			bucket.memoriesAdded += 1;
			if (row.pinned === 1) bucket.pinned += 1;

			if (
				typeof row.importance === "number" &&
				Number.isFinite(row.importance)
			) {
				bucket.totalImportance += row.importance;
				bucket.importanceSamples += 1;
			}

			incMap(bucket.typeBreakdown, normalizeMetricKey(row.type, "unknown"));
			incMap(bucket.sourceBreakdown, normalizeMetricKey(row.who, "unknown"));

			const tags = parseTags(row.tags);
			for (const tag of tags) {
				incMap(bucket.topTags, tag);
			}
		});
	}

	for (const row of historyRows) {
		const ts = parseTimestamp(row.created_at);
		if (ts === null) {
			invalidHistoryTimestamps += 1;
			continue;
		}

		forEachMatchingBucket(ts, buckets, (bucket) => {
			bucket.trackedEvents += 1;
			if (EVOLVED_EVENTS.has(row.event)) {
				bucket.evolved += 1;
				// Only count strengthened for events that also count as evolved
				// (updated/merged imply strength; recovered with strengthening reason also counts)
				if (row.event === "updated" || row.event === "merged") {
					bucket.strengthened += 1;
				} else if (row.reason && STRENGTHENED_REASON_PATTERN.test(row.reason)) {
					bucket.strengthened += 1;
				}
			}
			if (row.event === "recovered") {
				bucket.recovered += 1;
			}
		});
	}

	const responseBuckets: MemoryTimelineBucket[] = [];
	for (const spec of RANGE_SPECS) {
		const bucket = buckets.get(spec.eraIndex);
		if (!bucket) continue;
		const rawAvg =
			bucket.importanceSamples > 0
				? bucket.totalImportance / bucket.importanceSamples
				: 0;
		const avgImportance = Number(Math.min(1, Math.max(0, rawAvg)).toFixed(3));

		responseBuckets.push({
			eraIndex: spec.eraIndex,
			rangeKey: spec.key,
			label: spec.label,
			start: new Date(bucket.startMs).toISOString(),
			end: new Date(bucket.endMs).toISOString(),
			memoriesAdded: bucket.memoriesAdded,
			trackedEvents: bucket.trackedEvents,
			evolved: bucket.evolved,
			strengthened: bucket.strengthened,
			recovered: bucket.recovered,
			avgImportance,
			pinned: bucket.pinned,
			typeBreakdown: sortMetrics(bucket.typeBreakdown),
			sourceBreakdown: sortMetrics(bucket.sourceBreakdown),
			topTags: sortMetrics(bucket.topTags),
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		generatedFor: new Date(nowStartMs).toISOString(),
		rangePreset: "today-last_week-one_month",
		// Count of non-deleted memories within the 30-day query window with valid timestamps.
		// memoryRows.length includes rows with corrupt timestamps that fail parseTimestamp
		// and are excluded from all buckets — subtract them for an accurate count.
		totalMemories: memoryRows.length - invalidMemoryTimestamps,
		// Same rationale as totalMemories: subtract corrupt-timestamp rows that are
		// counted by historyRows.length but skipped via continue in the loop above.
		totalHistoryEvents: historyRows.length - invalidHistoryTimestamps,
		invalidMemoryTimestamps,
		invalidHistoryTimestamps,
		buckets: responseBuckets,
	};
}
