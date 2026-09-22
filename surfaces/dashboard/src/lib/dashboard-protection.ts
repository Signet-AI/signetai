import type { ProtectionStatus, ProtectionComponent as CoreProtectionComponent } from "@signet/core";
export type ProtectionReport = ProtectionStatus;
export type ProtectionComponent = CoreProtectionComponent;
export interface ProtectionSummary {
	readonly overallLabel: string;
	readonly components: readonly ProtectionComponent[];
	readonly missing: readonly string[];
	readonly degraded: readonly string[];
}
export function protectionSummary(report: ProtectionReport): ProtectionSummary {
	return {
		overallLabel:
			report.overall === "protected"
				? "Protected"
				: report.overall === "partial"
					? "Partially protected"
					: "Not protected",
		components: report.components,
		missing: report.missing,
		degraded: report.degraded,
	};
}
export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "[redacted]")
		.replace(/(?:\/home\/[^\s]+|\/Users\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, "[redacted]")
		.replace(/(contents?\s*:\s*)[^\s]+/gi, "$1[redacted]");
}
