import { describe, expect, it } from "bun:test";
import { createShutdownRequestGate } from "./daemon-shutdown";

describe("daemon shutdown request gate", () => {
	it("keeps a shutdown-time owner rejection from replacing the signal exit", () => {
		const gate = createShutdownRequestGate();
		const signal = { reason: "signal:SIGTERM", exitCode: 0 } as const;
		const ownerShutdown = { reason: "error:unhandledRejection", exitCode: 1 } as const;

		expect(gate.begin(signal)).toBe(true);
		expect(gate.begin(ownerShutdown)).toBe(false);
		expect(gate.primary).toEqual(signal);
	});
});
