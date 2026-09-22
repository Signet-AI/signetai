import { describe, expect, it } from "bun:test";
import { formatProtectionLine, projectProtectionStatus } from "./protection";

describe("CLI protection projection", () => {
	it("uses the daemon schema without exposing receipt or paths", () => {
		const projected = projectProtectionStatus({
			status: "unverified",
			protected: false,
			components: [{ id: "sqlite", status: "protected", detail: "present" }],
			restoreReceipt: null,
		});
		expect(projected).toEqual({
			status: "unverified",
			protected: false,
			components: [{ id: "sqlite", status: "protected", detail: "present" }],
		});
		expect(formatProtectionLine(projected)).toBe("Protection: unverified");
	});
});
