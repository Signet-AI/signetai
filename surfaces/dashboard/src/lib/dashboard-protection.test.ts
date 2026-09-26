import { expect, test } from "bun:test";
import { protectionSummary, redactSensitiveText, type ProtectionReport } from "./dashboard-protection";
const report: ProtectionReport = {
	status: "degraded",
	protected: false,
	overall: "partial",
	components: [],
	missing: [],
	degraded: ["sqlite"],
	restoreReceipt: null,
	privacy: { pathsRedacted: true, secretsRedacted: true, contentIncluded: false },
};
test("summarizes the shared protection contract", () => {
	const summary = protectionSummary(report);
	expect(summary.overallLabel).toBe("Partially protected");
	expect(summary.components).toEqual([]);
	expect(summary.degraded).toEqual(["sqlite"]);
});
test("redacts raw contents and sensitive paths", () => {
	expect(redactSensitiveText("token=abc /home/nick/.signet/secrets.json contents: hello")).toBe(
		"[redacted] [redacted] contents: [redacted]",
	);
});
