import { describe, expect, it } from "bun:test";
import {
	closeDbOwnerDuringShutdown,
	createShutdownRequestGate,
	forceExitDuringShutdownFlush,
	runShutdownCleanup,
} from "./daemon-shutdown";

describe("daemon shutdown request gate", () => {
	it("forces a fatal exit instead of waiting for an in-flight flush", () => {
		const calls: string[] = [];
		const flushInFlight = new Promise<void>(() => {});
		const forced = forceExitDuringShutdownFlush(
			flushInFlight,
			1,
			() => calls.push("logger"),
			(code: number) => {
				calls.push(`exit:${code}`);
			},
		);

		expect(forced).toBe(true);
		expect(calls).toEqual(["logger", "exit:1"]);
	});

	it("keeps a clean shutdown on its existing flush", () => {
		const calls: string[] = [];
		const forced = forceExitDuringShutdownFlush(
			Promise.resolve(),
			0,
			() => calls.push("logger"),
			(code: number) => {
				calls.push(`exit:${code}`);
			},
		);

		expect(forced).toBe(false);
		expect(calls).toEqual([]);
	});

	it("delivers a cleanup rejection to finalization without escalating a clean shutdown", async () => {
		const gate = createShutdownRequestGate();
		const cleanupError = new Error("database owner close failed");
		let settledError: unknown = null;
		expect(gate.begin({ reason: "signal:SIGTERM", exitCode: 0 })).toBe("begin");

		await runShutdownCleanup(
			async () => {
				throw cleanupError;
			},
			(error) => {
				settledError = error;
			},
		);

		expect(settledError).toBe(cleanupError);
		expect(gate.exitCode).toBe(0);
		expect(gate.fatalRequest).toBeNull();
	});

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
