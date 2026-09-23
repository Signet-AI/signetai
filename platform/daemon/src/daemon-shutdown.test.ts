import { describe, expect, it } from "bun:test";
import { closeDbOwnerDuringShutdown, createShutdownRequestGate } from "./daemon-shutdown";

describe("daemon shutdown request gate", () => {
	it("escalates a clean shutdown to a fatal exit without replacing its primary reason", () => {
		const gate = createShutdownRequestGate();
		const signal = { reason: "signal:SIGTERM", exitCode: 0 } as const;
		const fatal = { reason: "error:uncaughtException", exitCode: 1 } as const;

		expect(gate.begin(signal)).toBe("begin");
		expect(gate.begin({ reason: "signal:SIGINT", exitCode: 0 })).toBe("ignore");
		expect(gate.begin(fatal)).toBe("fatal");
		expect(gate.primary).toEqual(signal);
		expect(gate.fatalRequest).toEqual(fatal);
		expect(gate.begin({ reason: "error:unhandledRejection", exitCode: 1 })).toBe("fatal");
		expect(gate.fatalRequest).toEqual(fatal);
		expect(gate.exitCode).toBe(1);
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
