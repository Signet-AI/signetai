import { afterEach, describe, expect, mock, test } from "bun:test";
import { getUpdateState, initUpdateSystem } from "../../../../platform/daemon/src/update-system.js";
import { createDaemonClient } from "../lib/daemon.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

function unavailableDaemon(): void {
	globalThis.fetch = mock(async () => {
		throw new Error("simulated daemon unreachable");
	});
}

describe("daemon-off update fallback regression coverage", () => {
	test.each([
		["check --force", "/api/update/check?force=true"],
		["status", "/api/update/config"],
		["channel", "/api/update/config"],
		["enable", "/api/update/config"],
		["disable", "/api/update/config"],
		["install", "/api/update/run"],
	])("%s does not turn daemon unavailability into a connect error", async (_command, path) => {
		unavailableDaemon();
		const client = createDaemonClient(1);
		await expect(client.fetchDaemonResult(path)).resolves.toMatchObject({ ok: false, reason: "offline" });
	});

	test("simulated daemon startup failure is treated as unavailable", async () => {
		unavailableDaemon();
		const client = createDaemonClient(1);
		await expect(client.fetchDaemonResult("/api/update/config")).resolves.toMatchObject({
			ok: false,
			reason: "offline",
		});
	});

	test("offline status reads canonical pending-restart state", () => {
		initUpdateSystem("0.211.3", "/tmp/signet-update-test");
		const state = getUpdateState();
		expect(state).toHaveProperty("pendingRestartVersion");
		expect(state).toHaveProperty("lastAutoUpdateAt");
		expect(state).toHaveProperty("lastAutoUpdateError");
		expect(state).toHaveProperty("checkInProgress");
		expect(state).toHaveProperty("installInProgress");
	});
});
