import { describe, expect, it } from "bun:test";
import { aggregateProtection, type ProtectionComponent } from "./protection";

describe("protection contract", () => {
	it("requires current restore evidence before reporting protected", () => {
		const components: ProtectionComponent[] = [
			{ id: "root-authored", status: "protected", detail: "present" },
			{ id: "sqlite", status: "protected", detail: "present" },
		];
		expect(aggregateProtection(components)).toMatchObject({ status: "unverified", protected: false });
	});

	it("never treats git sync as protection and preserves deterministic component order", () => {
		const components: ProtectionComponent[] = [
			{ id: "sqlite", status: "protected", detail: "present" },
			{ id: "root-authored", status: "protected", detail: "present" },
			{ id: "filesystem-cache", status: "excluded-rebuildable", detail: "rebuildable" },
		];
		const result = aggregateProtection(components, { gitSynchronized: true });
		expect(result.status).toBe("unverified");
		expect(result.protected).toBe(false);
		expect(result.components.map((item) => item.id)).toEqual(["root-authored", "sqlite", "filesystem-cache"]);
	});

	it("reports degraded when a required component is stale or missing", () => {
		const result = aggregateProtection(
			[
				{ id: "root-authored", status: "protected", detail: "present" },
				{ id: "sqlite", status: "stale", detail: "old" },
				{ id: "runtime", status: "excluded-rebuildable", detail: "rebuildable" },
			],
			{ restoreReceipt: { at: "2026-01-01T00:00:00.000Z", valid: true } },
		);
		expect(result.status).toBe("degraded");
		expect(result.protected).toBe(false);
	});
});
