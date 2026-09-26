import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardProtectionReport } from "@/lib/api";
import { ProtectionRecoveryPanel } from "./protection-recovery";

const report: DashboardProtectionReport = {
	status: "degraded",
	protected: false,
	overall: "partial",
	components: [
		{ id: "managed-originals", status: "missing", detail: "Managed originals retention is missing" },
		{ id: "secrets", status: "unverified", detail: "Encrypted file provider has no verified recovery evidence" },
	],
	missing: ["managed-originals"],
	degraded: ["secrets"],
	restoreReceipt: null,
	privacy: { pathsRedacted: true, secretsRedacted: true, contentIncluded: false },
};

test("protection components keep status and full reason readable in a narrow system pane", () => {
	const markup = renderToStaticMarkup(<ProtectionRecoveryPanel report={report} />);
	expect(markup).not.toContain("sm:grid-cols-2");
	expect(markup).toContain('aria-label="Protection components"');
	expect(markup).toContain("Managed originals retention is missing");
	expect(markup).toContain("Encrypted file provider has no verified recovery evidence");
	expect(markup).toContain("<p class=");
});
