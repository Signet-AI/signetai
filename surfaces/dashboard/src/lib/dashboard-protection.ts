export type ProtectionOverall = "protected" | "partial" | "none";
export type ProtectionState = "protected" | "degraded" | "missing" | "unknown";

/** Temporary dashboard-compatible contract until the shared API export lands. */
export interface ProtectionComponent {
	readonly group: string;
	readonly name: string;
	readonly state: ProtectionState;
	readonly reason?: string;
	readonly remediation?: string;
}
export interface ProtectionReport {
	readonly overall: ProtectionOverall;
	readonly restoreTestedAt?: string | null;
	readonly restoreTestedScope?: string | null;
	readonly components: readonly ProtectionComponent[];
}
export interface ProtectionSummary {
	readonly overallLabel: string;
	readonly groups: readonly { name: string; components: readonly Omit<ProtectionComponent, "group">[] }[];
	readonly restore: { testedAt?: string | null; scope?: string | null };
}

export function protectionSummary(report: ProtectionReport): ProtectionSummary {
	const groups = new Map<string, Omit<ProtectionComponent, "group">[]>();
	for (const component of report.components) {
		const entries = groups.get(component.group) ?? [];
		const { group: _group, ...withoutGroup } = component;
		entries.push(withoutGroup);
		groups.set(component.group, entries);
	}
	return {
		overallLabel:
			report.overall === "protected"
				? "Protected"
				: report.overall === "partial"
					? "Partially protected"
					: "Not protected",
		groups: [...groups].map(([name, components]) => ({ name, components })),
		restore: { testedAt: report.restoreTestedAt, scope: report.restoreTestedScope },
	};
}

export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "[redacted]")
		.replace(/(?:\/home\/[^\s]+|\/Users\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, "[redacted]")
		.replace(/(contents?\s*:\s*)[^\s]+/gi, "$1[redacted]");
}
