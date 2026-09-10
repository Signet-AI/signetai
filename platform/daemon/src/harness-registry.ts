import type {
	BaseConnector,
	ConnectorHealth,
	ConnectorHealthStatus,
	ConnectorRecoveryCapabilities,
} from "@signet/connector-base";
import { existsSync } from "node:fs";

export type HarnessConnectorConstructor = new () => BaseConnector;
export type HarnessConnectorLoader = () => Promise<HarnessConnectorConstructor>;
export type HarnessAction = "connect" | "repair" | "reinitialize";

/**
 * The daemon's canonical external-harness registry. Install, inspection, and
 * dashboard enumeration all consume this map so a registered connector is
 * visible without another dashboard-specific list.
 */
export const HARNESS_INSTALLERS = {
	"claude-code": () => import("@signet/connector-claude-code").then((module) => module.ClaudeCodeConnector),
	codex: () => import("@signet/connector-codex").then((module) => module.CodexConnector),
	"hermes-agent": () => import("@signet/connector-hermes-agent").then((module) => module.HermesAgentConnector),
	opencode: () => import("@signet/connector-opencode").then((module) => module.OpenCodeConnector),
	openclaw: () => import("@signet/connector-openclaw").then((module) => module.OpenClawConnector),
	gemini: () => import("@signet/connector-gemini").then((module) => module.GeminiConnector),
	pi: () => import("@signet/connector-pi").then((module) => module.PiConnector),
	"oh-my-pi": () => import("@signet/connector-oh-my-pi").then((module) => module.OhMyPiConnector),
	kimi: () => import("@signet/connector-kimi").then((module) => module.KimiConnector),
	forge: () => import("@signet/connector-forge").then((module) => module.ForgeConnector),
} satisfies Readonly<Record<string, HarnessConnectorLoader>>;

export interface HarnessConnectorHealth {
	status: ConnectorHealthStatus;
	message: string;
	checkedAt: string;
}

export interface HarnessConnectorStatus {
	id: string;
	displayName: string;
	kind: "harness";
	description: "Harness connector";
	icon: string | null;
	available: boolean;
	configured: boolean;
	detected: boolean;
	installed: boolean;
	relevant: boolean;
	configPath: string | null;
	lastSeen: string | null;
	capabilities: ConnectorRecoveryCapabilities;
	health: HarnessConnectorHealth;
}

export type HarnessRegistry = Readonly<Record<string, HarnessConnectorLoader>>;

const HEALTH_STATUSES: readonly ConnectorHealthStatus[] = ["healthy", "degraded", "unhealthy", "needs-auth"];

function isHealthStatus(value: unknown): value is ConnectorHealthStatus {
	return typeof value === "string" && HEALTH_STATUSES.some((status) => status === value);
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return fallback;
}

function displayNameFor(id: string): string {
	return id
		.split("-")
		.filter((part) => part.length > 0)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

function unavailableCapabilities(): ConnectorRecoveryCapabilities {
	return { repair: false, reinitialize: false, reinitializeRequiresConfirmation: false };
}

function defaultHealth(installed: boolean, detected: boolean, checkedAt: string): HarnessConnectorHealth {
	if (installed)
		return { status: "degraded", message: "Integration detected; runtime health has not been verified.", checkedAt };
	if (detected) {
		return {
			status: "degraded",
			message: "Harness detected; Signet integration is not configured.",
			checkedAt,
		};
	}
	return { status: "unhealthy", message: "Signet integration is not installed.", checkedAt };
}

function normalizeHealth(
	result: ConnectorHealth,
	installed: boolean,
	detected: boolean,
	checkedAt: string,
): HarnessConnectorHealth {
	if (!isHealthStatus(result.status)) return defaultHealth(installed, detected, checkedAt);
	return {
		status: result.status,
		message: result.message.trim() || defaultHealth(installed, detected, checkedAt).message,
		checkedAt,
	};
}

function readCapabilities(connector: BaseConnector): ConnectorRecoveryCapabilities {
	try {
		const candidate = connector.getRecoveryCapabilities?.();
		if (!candidate) return unavailableCapabilities();
		return {
			repair: candidate.repair === true,
			reinitialize: candidate.reinitialize === true,
			reinitializeRequiresConfirmation:
				candidate.reinitialize === true && candidate.reinitializeRequiresConfirmation === true,
		};
	} catch {
		return unavailableCapabilities();
	}
}

function readIconAsset(connector: BaseConnector): string | null {
	try {
		const icon = connector.getIconAsset();
		return typeof icon === "string" && icon.trim() ? icon.trim() : null;
	} catch {
		return null;
	}
}

function unavailableStatus(
	id: string,
	configured: boolean,
	checkedAt: string,
	error: unknown,
	lastSeen: string | null,
): HarnessConnectorStatus {
	return {
		id,
		displayName: displayNameFor(id),
		kind: "harness",
		description: "Harness connector",
		icon: null,
		available: false,
		configured,
		detected: false,
		installed: false,
		relevant: configured || lastSeen !== null,
		configPath: null,
		lastSeen,
		capabilities: unavailableCapabilities(),
		health: {
			status: "unhealthy",
			message: `Connector plugin failed to load: ${errorMessage(error, "unknown loader error")}`,
			checkedAt,
		},
	};
}

export async function inspectRegisteredConnector(
	id: string,
	loader: HarnessConnectorLoader,
	configured: boolean,
	lastSeen: string | null,
	checkedAt: string,
): Promise<HarnessConnectorStatus> {
	let Connector: HarnessConnectorConstructor;
	try {
		Connector = await loader();
	} catch (error) {
		return unavailableStatus(id, configured, checkedAt, error, lastSeen);
	}

	let connector: BaseConnector;
	try {
		connector = new Connector();
	} catch (error) {
		return unavailableStatus(id, configured, checkedAt, error, lastSeen);
	}

	let configPath: string | null = null;
	try {
		configPath = connector.getConfigPath();
	} catch {
		// A connector may not have a usable config path until it is installed.
	}

	let detected = false;
	try {
		detected = connector.isDetected?.() ?? (configPath !== null && existsSync(configPath));
	} catch {
		detected = false;
	}

	let installed = false;
	try {
		installed = connector.isInstalled();
	} catch {
		installed = false;
	}

	let health = defaultHealth(installed, detected, checkedAt);
	try {
		const inspection = await connector.inspectHealth?.();
		if (inspection) health = normalizeHealth(inspection, installed, detected, checkedAt);
	} catch (error) {
		health = {
			status: "unhealthy",
			message: `Health inspection failed: ${errorMessage(error, "unknown inspection error")}`,
			checkedAt,
		};
	}

	return {
		id,
		displayName: connector.name || displayNameFor(id),
		kind: "harness",
		description: "Harness connector",
		icon: readIconAsset(connector),
		available: true,
		configured,
		detected,
		installed,
		relevant: configured || detected || installed || lastSeen !== null,
		configPath,
		lastSeen,
		capabilities: readCapabilities(connector),
		health,
	};
}

export function getHarnessLoader(
	id: string,
	registry: HarnessRegistry = HARNESS_INSTALLERS,
): HarnessConnectorLoader | null {
	return Object.entries(registry).find(([registeredId]) => registeredId === id)?.[1] ?? null;
}

export async function createHarnessConnector(
	id: string,
	registry: HarnessRegistry = HARNESS_INSTALLERS,
): Promise<BaseConnector | null> {
	const loader = getHarnessLoader(id, registry);
	if (!loader) return null;
	const Connector = await loader();
	return new Connector();
}
