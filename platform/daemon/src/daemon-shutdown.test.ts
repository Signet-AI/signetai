import { describe, expect, it } from "bun:test";
import { closeDbOwnerDuringShutdown, createShutdownRequestGate } from "./daemon-shutdown";

describe("daemon shutdown request gate", () => {
	it("keeps a shutdown-time owner rejection from replacing the signal exit", () => {
		const gate = createShutdownRequestGate();
		const signal = { reason: "signal:SIGTERM", exitCode: 0 } as const;
		const ownerShutdown = { reason: "error:unhandledRejection", exitCode: 1 } as const;

		expect(gate.begin(signal)).toBe(true);
		expect(gate.begin(ownerShutdown)).toBe(false);
		expect(gate.primary).toEqual(signal);
	});

	it("closes the owner while maintenance leases drain", async () => {
		const calls: string[] = [];
		let releaseMaintenance = (): void => {};
		const maintenanceDrain = new Promise<void>((resolve) => {
			releaseMaintenance = resolve;
		});

		await closeDbOwnerDuringShutdown(
			() => {
				calls.push("maintenance");
				return maintenanceDrain;
			},
			async () => {
				calls.push("owner");
				releaseMaintenance();
			},
		);

		expect(calls).toEqual(["maintenance", "owner"]);
	});
});
