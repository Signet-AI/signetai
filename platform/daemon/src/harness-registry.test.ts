import { expect, test } from "bun:test";
import { BaseConnector, type ConnectorHealth, type InstallResult, type UninstallResult } from "@signet/connector-base";
import { enumerateHarnessConnectors, type HarnessRegistry } from "./harness-registry";

class HealthyConnector extends BaseConnector {
	readonly name = "Alpha Harness";
	readonly harnessId = "alpha";

	getIconAsset(): string {
		return "alpha.svg";
	}

	async install(_basePath: string): Promise<InstallResult> {
		return { success: true, message: "installed", filesWritten: [] };
	}

	async uninstall(): Promise<UninstallResult> {
		return { filesRemoved: [] };
	}

	isInstalled(): boolean {
		return true;
	}

	getConfigPath(): string {
		return "/tmp/alpha-config-that-is-not-used";
	}
}

class NeedsAuthConnector extends HealthyConnector {
	readonly name = "Bravo Harness";
	readonly harnessId = "bravo";

	isInstalled(): boolean {
		return false;
	}

	isDetected(): boolean {
		return true;
	}

	async inspectHealth(): Promise<ConnectorHealth> {
		return { status: "needs-auth", message: "Credentials expired." };
	}
	getConfigPath(): string {
		return "/tmp/bravo-config-that-is-not-used";
	}
}

class BrokenHealthConnector extends HealthyConnector {
	readonly name = "Charlie Harness";
	readonly harnessId = "charlie";

	isInstalled(): boolean {
		return false;
	}

	isDetected(): boolean {
		return true;
	}

	async inspectHealth(): Promise<ConnectorHealth> {
		throw new Error("probe unavailable");
	}
	getConfigPath(): string {
		return "/tmp/charlie-config-that-is-not-used";
	}
}

test("enumeration follows the supplied registry and isolates connector failures", async () => {
	const registry: HarnessRegistry = {
		alpha: async () => HealthyConnector,
		bravo: async () => NeedsAuthConnector,
		charlie: async () => BrokenHealthConnector,
		missing: async () => {
			throw new Error("bundle missing");
		},
	};

	const statuses = await enumerateHarnessConnectors(
		["bravo", "missing"],
		new Map([["bravo", "2026-09-09T12:00:00.000Z"]]),
		registry,
		() => new Date("2026-09-09T12:01:00.000Z"),
	);

	expect(statuses.map((status) => status.id)).toEqual(["alpha", "bravo", "charlie", "missing"]);
	expect(statuses.find((status) => status.id === "alpha")).toMatchObject({
		available: true,
		icon: "alpha.svg",
		installed: true,
		relevant: true,
		health: { status: "healthy", checkedAt: "2026-09-09T12:01:00.000Z" },
	});
	expect(statuses.find((status) => status.id === "bravo")).toMatchObject({
		configured: true,
		detected: true,
		relevant: true,
		health: { status: "needs-auth", message: "Credentials expired." },
	});
	expect(statuses.find((status) => status.id === "charlie")).toMatchObject({
		available: true,
		relevant: true,
		health: { status: "unhealthy", message: "Health inspection failed: probe unavailable" },
	});
	expect(statuses.find((status) => status.id === "missing")).toMatchObject({
		available: false,
		configured: true,
		relevant: true,
		health: { status: "unhealthy", message: "Connector plugin failed to load: bundle missing" },
	});
});

test("base recovery actions reuse the connector's canonical install path", async () => {
	let installCalls = 0;
	class RecordingConnector extends HealthyConnector {
		async install(_basePath: string): Promise<InstallResult> {
			installCalls += 1;
			return { success: true, message: "reconciled", filesWritten: [] };
		}
	}

	const connector = new RecordingConnector();
	await connector.repair("/workspace");
	await connector.reinitialize("/workspace");

	expect(installCalls).toBe(2);
	expect(connector.getRecoveryCapabilities()).toEqual({
		repair: true,
		reinitialize: true,
		reinitializeRequiresConfirmation: true,
	});
});
