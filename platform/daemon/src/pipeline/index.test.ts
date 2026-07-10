import { describe, expect, it } from "bun:test";
import { promoteSummaryWorkerIfAvailable } from "./index";

describe("promoteSummaryWorkerIfAvailable", () => {
	it("does not promote when shutdown occurs during the availability check", async () => {
		let resolveAvailability: ((available: boolean) => void) | undefined;
		const availability = new Promise<boolean>((resolve) => {
			resolveAvailability = resolve;
		});
		let stopped = false;
		let promotions = 0;

		const pending = promoteSummaryWorkerIfAvailable(
			() => availability,
			() => stopped,
			() => {
				promotions += 1;
			},
		);
		stopped = true;
		resolveAvailability?.(true);

		expect(await pending).toBe(false);
		expect(promotions).toBe(0);
	});

	it("promotes once when availability succeeds and recovery is active", async () => {
		let promotions = 0;
		const promoted = await promoteSummaryWorkerIfAvailable(
			async () => true,
			() => false,
			() => {
				promotions += 1;
			},
		);

		expect(promoted).toBe(true);
		expect(promotions).toBe(1);
	});
});
