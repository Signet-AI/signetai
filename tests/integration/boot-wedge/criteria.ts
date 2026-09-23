/** Boot-wedge gate criteria. Keep the thresholds explicit and reviewable. */

export const BOOT_TIMEOUT_MS = 60_000;
export const OBSERVATION_MS = 30_000;
export const LIVE_REQUEST_TIMEOUT_MS = 2_000;
export const LIVE_INTERVAL_MS = 250;
export const CPU_INTERVAL_MS = 500;
export const CPU_CEILING_PERCENT = 95;
export const MIN_CPU_SAMPLES = 5;

export interface BootWedgeMeasurements {
	readonly startupMs: number;
	readonly live: {
		readonly samples: number;
		readonly successes: number;
		readonly failures: number;
		readonly maxMs: number;
	};
	readonly cpu: {
		readonly samples: number;
		readonly maxPercent: number;
	};
}

export interface BootWedgeCheck {
	readonly name: string;
	readonly pass: boolean;
	readonly observed: string;
	readonly limit: string;
}

export interface BootWedgeEvaluation {
	readonly pass: boolean;
	readonly checks: readonly BootWedgeCheck[];
}

export function evaluateBootWedge(measurements: BootWedgeMeasurements): BootWedgeEvaluation {
	const checks: BootWedgeCheck[] = [
		{
			name: "daemon becomes live",
			pass: measurements.startupMs >= 0 && measurements.startupMs <= BOOT_TIMEOUT_MS,
			observed: `${Math.round(measurements.startupMs)}ms`,
			limit: `<= ${BOOT_TIMEOUT_MS}ms`,
		},
		{
			name: "/health/live stays responsive",
			pass:
				measurements.live.samples > 0 &&
				measurements.live.successes === measurements.live.samples &&
				measurements.live.maxMs <= LIVE_REQUEST_TIMEOUT_MS,
			observed: `${measurements.live.successes}/${measurements.live.samples} successful, max ${Math.round(measurements.live.maxMs)}ms`,
			limit: `all HTTP 200, <= ${LIVE_REQUEST_TIMEOUT_MS}ms`,
		},
		{
			name: "daemon CPU stays below idle ceiling",
			pass: measurements.cpu.samples >= MIN_CPU_SAMPLES && measurements.cpu.maxPercent < CPU_CEILING_PERCENT,
			observed: `${measurements.cpu.samples} samples, max ${measurements.cpu.maxPercent.toFixed(1)}%`,
			limit: `>= ${MIN_CPU_SAMPLES} samples, < ${CPU_CEILING_PERCENT}%`,
		},
	];
	return { pass: checks.every((check) => check.pass), checks };
}
