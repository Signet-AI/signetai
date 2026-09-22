import { expect, test } from "bun:test";
import { protectionSummary, redactSensitiveText, type ProtectionReport } from "./dashboard-protection";

const report: ProtectionReport = {
	overall: "partial",
	restoreTestedAt: "2026-09-21T12:00:00.000Z",
	restoreTestedScope: "workspace backup",
	components: [
		{ group: "Evidence", name: "Source snapshots", state: "protected" },
		{
			group: "Indexes",
			name: "Vector index",
			state: "degraded",
			reason: "rebuild required",
			remediation: "Rebuild index",
		},
	],
};

test("summarizes protection with component groups and remediation without secrets", () => {
	const summary = protectionSummary(report);
	expect(summary.overallLabel).toBe("Partially protected");
	expect(summary.groups).toEqual([
		{ name: "Evidence", components: [{ name: "Source snapshots", state: "protected" }] },
		{
			name: "Indexes",
			components: [
				{ name: "Vector index", state: "degraded", reason: "rebuild required", remediation: "Rebuild index" },
			],
		},
	]);
	expect(summary.restore).toEqual({ testedAt: report.restoreTestedAt, scope: report.restoreTestedScope });
});

test("redacts raw contents and sensitive paths", () => {
	expect(redactSensitiveText("token=abc /home/nick/.signet/secrets.json contents: hello")).toBe(
		"[redacted] [redacted] contents: [redacted]",
	);
});
