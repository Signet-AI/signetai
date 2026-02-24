/**
 * Thin wrapper around cron-parser for scheduled task cron expressions.
 */

import { CronExpressionParser } from "cron-parser";

/** Compute the next run time from a cron expression, relative to `from`. */
export function computeNextRun(
	expr: string,
	from: Date = new Date(),
): string {
	const cron = CronExpressionParser.parse(expr, { currentDate: from });
	return cron.next().toISOString();
}

/** Validate a cron expression. Returns true if valid. */
export function validateCron(expr: string): boolean {
	try {
		CronExpressionParser.parse(expr);
		return true;
	} catch {
		return false;
	}
}

/** Standard presets for the dashboard UI. */
export const CRON_PRESETS = [
	{ label: "Every 15 min", expression: "*/15 * * * *" },
	{ label: "Hourly", expression: "0 * * * *" },
	{ label: "Daily 9am", expression: "0 9 * * *" },
	{ label: "Weekly Mon 9am", expression: "0 9 * * 1" },
] as const;
