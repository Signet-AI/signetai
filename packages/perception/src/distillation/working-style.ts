/**
 * Working Style Analyzer
 *
 * Analyzes temporal patterns from perception capture data to determine
 * the user's working style — peak hours, session lengths, context switching,
 * and tool usage patterns.
 */

import type { WorkingStyle } from "./types";

/**
 * Minimal database interface for working style queries.
 * Accepts the raw SQLite db (not the Database wrapper).
 */
interface StyleDb {
	prepare(sql: string): {
		all(...args: unknown[]): Record<string, unknown>[];
		get(...args: unknown[]): Record<string, unknown> | undefined;
	};
}

/**
 * Analyze working style from perception_screen and perception_terminal tables.
 */
export async function analyzeWorkingStyle(db: StyleDb): Promise<WorkingStyle> {
	const peakHours = detectPeakHours(db);
	const sessionStats = estimateSessionDuration(db);
	const contextSwitch = estimateContextSwitchFrequency(db);
	const breakFreq = estimateBreakFrequency(db, sessionStats.averageGapMinutes);
	const appUsage = analyzeAppUsage(db);
	const terminalPercent = analyzeTerminalUsagePercent(db);

	return {
		peakHours,
		averageSessionMinutes: sessionStats.averageSessionMinutes,
		contextSwitchFrequency: contextSwitch,
		breakFrequency: breakFreq,
		mostUsedApps: appUsage,
		terminalUsagePercent: terminalPercent,
		totalCapturedHours: sessionStats.totalHours,
	};
}

/**
 * Detect peak activity hours from screen and terminal captures.
 * Returns an array of hour numbers (0-23) sorted by activity density.
 */
function detectPeakHours(db: StyleDb): number[] {
	// Count captures per hour across all data
	const hourCounts: number[] = new Array(24).fill(0);

	try {
		// Screen captures by hour
		const screenRows = db
			.prepare(
				`SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as cnt
				 FROM perception_screen
				 GROUP BY hour`,
			)
			.all() as Array<{ hour: number; cnt: number }>;

		for (const row of screenRows) {
			hourCounts[row.hour] += row.cnt;
		}
	} catch {
		// Table might not exist or be empty
	}

	try {
		// Terminal captures by hour
		const termRows = db
			.prepare(
				`SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as cnt
				 FROM perception_terminal
				 GROUP BY hour`,
			)
			.all() as Array<{ hour: number; cnt: number }>;

		for (const row of termRows) {
			hourCounts[row.hour] += row.cnt;
		}
	} catch {
		// Table might not exist or be empty
	}

	// Find total activity
	const total = hourCounts.reduce((a, b) => a + b, 0);
	if (total === 0) return [9, 10, 11, 14, 15, 16]; // sensible defaults

	// Calculate mean activity per active hour
	const activeHours = hourCounts.filter((c) => c > 0);
	if (activeHours.length === 0) return [9, 10, 11, 14, 15, 16];

	const mean = total / activeHours.length;

	// Peak hours = hours with above-mean activity
	const peaks: Array<{ hour: number; count: number }> = [];
	for (let h = 0; h < 24; h++) {
		if (hourCounts[h] > mean * 0.7) {
			peaks.push({ hour: h, count: hourCounts[h] });
		}
	}

	// Sort by activity count descending, return top hours
	peaks.sort((a, b) => b.count - a.count);
	return peaks.slice(0, 8).map((p) => p.hour).sort((a, b) => a - b);
}

/**
 * Estimate average session duration from screen capture timestamps.
 * A "session" is a contiguous period of captures with gaps < 30 min.
 */
function estimateSessionDuration(db: StyleDb): {
	averageSessionMinutes: number;
	averageGapMinutes: number;
	totalHours: number;
} {
	const SESSION_GAP_MS = 30 * 60 * 1000; // 30 min gap = new session

	let timestamps: number[] = [];

	try {
		const rows = db
			.prepare(
				`SELECT timestamp FROM perception_screen
				 ORDER BY timestamp ASC
				 LIMIT 10000`,
			)
			.all() as Array<{ timestamp: string }>;

		timestamps = rows
			.map((r) => new Date(r.timestamp).getTime())
			.filter((t) => !isNaN(t));
	} catch {
		// empty
	}

	if (timestamps.length < 2) {
		return { averageSessionMinutes: 60, averageGapMinutes: 5, totalHours: 0 };
	}

	const sessions: number[] = [];
	const gaps: number[] = [];
	let sessionStart = timestamps[0];

	for (let i = 1; i < timestamps.length; i++) {
		const gap = timestamps[i] - timestamps[i - 1];
		if (gap > SESSION_GAP_MS) {
			// End of session
			const sessionLength = timestamps[i - 1] - sessionStart;
			if (sessionLength > 0) {
				sessions.push(sessionLength / 60_000);
			}
			sessionStart = timestamps[i];
		} else {
			gaps.push(gap / 60_000);
		}
	}

	// Close last session
	const lastSession = timestamps[timestamps.length - 1] - sessionStart;
	if (lastSession > 0) {
		sessions.push(lastSession / 60_000);
	}

	const totalMs = timestamps[timestamps.length - 1] - timestamps[0];
	const totalHours = totalMs / (60 * 60 * 1000);

	const avgSession =
		sessions.length > 0
			? sessions.reduce((a, b) => a + b, 0) / sessions.length
			: 60;

	const avgGap =
		gaps.length > 0
			? gaps.reduce((a, b) => a + b, 0) / gaps.length
			: 5;

	return {
		averageSessionMinutes: Math.round(avgSession),
		averageGapMinutes: Math.round(avgGap * 10) / 10,
		totalHours: Math.round(totalHours * 10) / 10,
	};
}

/**
 * Estimate context switch frequency from screen capture app changes.
 */
function estimateContextSwitchFrequency(
	db: StyleDb,
): "low" | "moderate" | "high" {
	try {
		const rows = db
			.prepare(
				`SELECT focused_app, timestamp
				 FROM perception_screen
				 ORDER BY timestamp ASC
				 LIMIT 5000`,
			)
			.all() as Array<{ focused_app: string; timestamp: string }>;

		if (rows.length < 10) return "moderate";

		let switches = 0;
		let lastApp = rows[0].focused_app;

		for (let i = 1; i < rows.length; i++) {
			if (rows[i].focused_app !== lastApp) {
				switches++;
				lastApp = rows[i].focused_app;
			}
		}

		// Calculate switches per hour
		const firstTs = new Date(rows[0].timestamp).getTime();
		const lastTs = new Date(rows[rows.length - 1].timestamp).getTime();
		const hours = (lastTs - firstTs) / (60 * 60 * 1000);

		if (hours <= 0) return "moderate";
		const switchesPerHour = switches / hours;

		if (switchesPerHour < 5) return "low";
		if (switchesPerHour < 15) return "moderate";
		return "high";
	} catch {
		return "moderate";
	}
}

/**
 * Estimate break frequency from session gap patterns.
 */
function estimateBreakFrequency(
	db: StyleDb,
	avgGapMinutes: number,
): "regular" | "irregular" | "rare" {
	// If average gap between captures is very short and sessions are long,
	// breaks are rare. If gaps are moderate and regular, breaks are regular.
	try {
		const rows = db
			.prepare(
				`SELECT timestamp FROM perception_screen
				 ORDER BY timestamp ASC
				 LIMIT 5000`,
			)
			.all() as Array<{ timestamp: string }>;

		if (rows.length < 20) return "irregular";

		// Count gaps > 10 min (potential breaks)
		let breakCount = 0;
		const breakDurations: number[] = [];

		for (let i = 1; i < rows.length; i++) {
			const gap =
				(new Date(rows[i].timestamp).getTime() -
					new Date(rows[i - 1].timestamp).getTime()) /
				60_000;
			if (gap > 10 && gap < 120) {
				breakCount++;
				breakDurations.push(gap);
			}
		}

		const totalHours =
			(new Date(rows[rows.length - 1].timestamp).getTime() -
				new Date(rows[0].timestamp).getTime()) /
			(60 * 60 * 1000);

		if (totalHours <= 0) return "irregular";

		const breaksPerHour = breakCount / totalHours;

		if (breaksPerHour < 0.2) return "rare";
		if (breaksPerHour > 0.5) return "regular";

		// Check regularity of break intervals
		if (breakDurations.length >= 3) {
			const mean =
				breakDurations.reduce((a, b) => a + b, 0) / breakDurations.length;
			const variance =
				breakDurations.reduce((a, b) => a + (b - mean) ** 2, 0) /
				breakDurations.length;
			const cv = Math.sqrt(variance) / mean; // coefficient of variation

			return cv < 0.5 ? "regular" : "irregular";
		}

		return "irregular";
	} catch {
		return "irregular";
	}
}

/**
 * Analyze most-used applications from screen captures.
 */
function analyzeAppUsage(
	db: StyleDb,
): Array<{ app: string; percentage: number }> {
	try {
		const rows = db
			.prepare(
				`SELECT focused_app, COUNT(*) as cnt
				 FROM perception_screen
				 WHERE focused_app IS NOT NULL AND focused_app != ''
				 GROUP BY focused_app
				 ORDER BY cnt DESC
				 LIMIT 10`,
			)
			.all() as Array<{ focused_app: string; cnt: number }>;

		const total = rows.reduce((sum, r) => sum + r.cnt, 0);
		if (total === 0) return [];

		return rows.map((r) => ({
			app: r.focused_app,
			percentage: Math.round((r.cnt / total) * 100),
		}));
	} catch {
		return [];
	}
}

/**
 * Estimate what percentage of activity involves terminal use.
 */
function analyzeTerminalUsagePercent(db: StyleDb): number {
	try {
		const terminalRow = db
			.prepare(
				`SELECT COUNT(*) as cnt FROM perception_screen
				 WHERE LOWER(focused_app) LIKE '%terminal%'
				    OR LOWER(focused_app) LIKE '%iterm%'
				    OR LOWER(focused_app) LIKE '%wezterm%'
				    OR LOWER(focused_app) LIKE '%kitty%'
				    OR LOWER(focused_app) LIKE '%alacritty%'
				    OR LOWER(focused_app) LIKE '%hyper%'`,
			)
			.get() as { cnt: number } | undefined;

		const totalRow = db
			.prepare(`SELECT COUNT(*) as cnt FROM perception_screen`)
			.get() as { cnt: number } | undefined;

		const termCount = terminalRow?.cnt ?? 0;
		const totalCount = totalRow?.cnt ?? 0;

		if (totalCount === 0) return 0;
		return Math.round((termCount / totalCount) * 100);
	} catch {
		return 0;
	}
}
