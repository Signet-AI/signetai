import { describe, expect, it } from "bun:test";
import { aggregateProtection, type ProtectionComponent } from "./protection";

const component = (overrides: Partial<ProtectionComponent> = {}): ProtectionComponent => ({
	id: "sqlite",
	type: "database",
	authority: "daemon",
	location: "workspace/memory.db",
	mechanism: "backup",
	state: "protected",
	required: true,
	intentionallyExcluded: false,
	backupAt: "2026-09-20T00:00:00.000Z",
	restoreVerifiedAt: "2026-09-21T00:00:00.000Z",
	verifiedScope: "workspace",
	...overrides,
});

describe("protection contract", () => {
	it("returns the exact aggregate shape and deterministic order", () => {
		const result = aggregateProtection(
			[
				component(),
				component({ id: "secrets", type: "secret", authority: "external", location: "keyring", mechanism: "keychain" }),
			],
			{ now: "2026-09-22T00:00:00.000Z" },
		);
		expect(result).toEqual({
			overall: "protected",
			components: [expect.objectContaining({ id: "sqlite" }), expect.objectContaining({ id: "secrets" })],
			missing: [],
			degraded: [],
			privacy: { pathsRedacted: true, secretsRedacted: true },
		});
	});
	it("makes unknown required components prevent protected", () => {
		const result = aggregateProtection([component({ state: "unknown", reason: "not checked" })], {
			now: "2026-09-22T00:00:00.000Z",
		});
		expect(result.overall).toBe("partial");
		expect(result.degraded).toEqual(["sqlite"]);
	});
	it("uses the stale window and does not count git synchronization", () => {
		const result = aggregateProtection(
			[component({ backupAt: "2026-07-01T00:00:00.000Z", restoreVerifiedAt: null, mechanism: "git" })],
			{ now: "2026-09-22T00:00:00.000Z", gitSynchronized: true },
		);
		expect(result.overall).toBe("partial");
		expect(result.degraded).toEqual(["sqlite"]);
	});
});
