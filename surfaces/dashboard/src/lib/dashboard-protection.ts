import type { ProtectionComponent as CoreProtectionComponent, ProtectionStatus } from "@signet/core";

export type ProtectionReport = ProtectionStatus;
export type ProtectionComponent = CoreProtectionComponent;
export interface ProtectionGroup {
	readonly name: string;
	readonly components: readonly {
		readonly name: string;
		readonly state: string;
		readonly reason?: string;
		readonly remediation?: string;
	}[];
}
export interface ProtectionSummary {
	readonly overallLabel: string;
	readonly components: readonly ProtectionComponent[];
	readonly missing: readonly string[];
	readonly degraded: readonly string[];
	readonly restore: { readonly testedAt: string | null; readonly scope: string | null };
	readonly groups: readonly ProtectionGroup[];
}

export function protectionSummary(report: ProtectionReport): ProtectionSummary {
	const restored = report.components
		.filter((component) => component.restoreVerifiedAt)
		.sort((a, b) => Date.parse(b.restoreVerifiedAt ?? "") - Date.parse(a.restoreVerifiedAt ?? ""));
	const groups = new Map<string, ProtectionGroup["components"][number][]>();
	for (const component of report.components) {
		const group = component.authority;
		const entries = groups.get(group) ?? [];
		entries.push({
			name: component.id,
			state: component.state,
			reason: component.reason,
			remediation: component.remediation,
		});
		groups.set(group, entries);
	}
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
			testedAt: restored[0]?.restoreVerifiedAt ?? null,
			scope: restored[0]?.verifiedScope ?? null,
		},
		groups: [...groups.entries()].map(([name, components]) => ({ name, components })),
	};
}

export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "[redacted]")
		.replace(/(?:\/home\/[^\s]+|\/Users\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, "[redacted]")
		.replace(/(contents?\s*:\s*)[^\s]+/gi, "$1[redacted]");
}
