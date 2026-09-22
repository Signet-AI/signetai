import { describe, expect, it } from "bun:test";
import { formatProtectionLine, projectProtectionStatus } from "./protection";
const payload = {
	overall: "partial" as const,
	components: [],
	missing: [],
	degraded: ["sqlite" as const],
	privacy: { pathsRedacted: true as const, secretsRedacted: true as const },
};
describe("CLI protection projection", () => {
	it("passes the shared daemon schema through", () => {
		expect(projectProtectionStatus(payload)).toEqual(payload);
		expect(formatProtectionLine(payload)).toBe("Protection: partial");
	});
});
