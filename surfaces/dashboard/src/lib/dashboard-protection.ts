import type { ProtectionStatus, ProtectionComponent as CoreProtectionComponent } from "@signet/core";
export type ProtectionReport = ProtectionStatus;
export type ProtectionComponent = CoreProtectionComponent;
export interface ProtectionSummary {
	readonly overallLabel: string;
	readonly components: readonly ProtectionComponent[];
	readonly missing: readonly string[];
	readonly degraded: readonly string[];
	readonly restore: { readonly testedAt: string | null; readonly scope: string | null };
	readonly groups: readonly {
		readonly name: string;
		readonly components: readonly {
			readonly name: string;
			readonly state: ProtectionComponent["status"];
			readonly reason?: string;
		}[];
	}[];
}
export function protectionSummary(report: ProtectionReport): ProtectionSummary {
	const components = report.components.map((component) => ({
		name: component.id,
		state: component.status,
		reason: component.detail,
	}));
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
		restore: {
			testedAt: report.restoreReceipt?.at ?? null,
			scope: report.restoreReceipt?.components?.join(", ") ?? null,
		},
		groups: [{ name: "Components", components }],
	};
}
export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "[redacted]")
		.replace(/(?:\/home\/[^\s]+|\/Users\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, "[redacted]")
		.replace(/(contents?\s*:\s*)[^\s]+/gi, "$1[redacted]");
}
