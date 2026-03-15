/**
 * MCP Auto-Probe Module — Signet OS Phase 1b
 *
 * When a user installs an MCP server, this module probes it to discover
 * tools, resources, and any declared Signet manifest. If no manifest is
 * found, it generates an auto-card fallback so every MCP server gets
 * dashboard presence on install with zero effort from MCP authors.
 *
 * Architecture:
 *   - probeServer()       — connects to the server, discovers capabilities
 *   - parseManifest()     — extracts signet.app block from server metadata
 *   - generateAutoCard()  — creates fallback manifest from tool/resource list
 *   - storeProbeResult()  — persists probe result + app tray entry to disk
 *   - loadAppTray()       — reads persisted app tray entries
 *
 * Storage:
 *   ~/.agents/marketplace/app-manifests/<serverId>.json — per-server probe result
 *   ~/.agents/marketplace/app-tray.json                — app tray index
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	AppTrayEntry,
	AutoCardManifest,
	AutoCardResource,
	AutoCardToolAction,
	McpProbeResult,
	SignetAppManifest,
} from "@signet/core";
import { DEFAULT_APP_SIZE } from "@signet/core";
import { logger } from "./logger.js";
import { getSecret } from "./secrets.js";
import type {
	InstalledMarketplaceMcpServer,
	MarketplaceMcpConfigHttp,
	MarketplaceMcpConfigStdio,
} from "./routes/marketplace.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getManifestsDir(): string {
	return join(getAgentsDir(), "marketplace", "app-manifests");
}

function getAppTrayPath(): string {
	return join(getAgentsDir(), "marketplace", "app-tray.json");
}

function ensureManifestsDir(): void {
	const dir = getManifestsDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// Secret resolution (reuses marketplace pattern)
// ---------------------------------------------------------------------------

const SECRET_REF_PREFIX = "secret://";

function parseSecretReference(value: string): string | null {
	if (!value.startsWith(SECRET_REF_PREFIX)) return null;
	const name = value.slice(SECRET_REF_PREFIX.length).trim();
	return name || null;
}

async function resolveSecretReferences(
	values: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		const secretName = parseSecretReference(value);
		if (!secretName) {
			resolved[key] = value;
			continue;
		}
		resolved[key] = await getSecret(secretName);
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// MCP Client connection (follows marketplace.ts pattern exactly)
// ---------------------------------------------------------------------------

async function withProbeClient<T>(
	server: InstalledMarketplaceMcpServer,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const timeoutMs = Math.min(server.config.timeoutMs, 30_000);

	const run = async (): Promise<T> => {
		const client = new Client({
			name: "signet-os-probe",
			version: "0.1.0",
		});

		if (server.config.transport === "stdio") {
			const runtimeEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) {
				if (typeof v === "string") runtimeEnv[k] = v;
			}
			const resolvedEnv = await resolveSecretReferences(
				(server.config as MarketplaceMcpConfigStdio).env,
			);
			const stdioConfig = server.config as MarketplaceMcpConfigStdio;
			const transport = new StdioClientTransport({
				command: stdioConfig.command,
				args: [...stdioConfig.args],
				env: { ...runtimeEnv, ...resolvedEnv },
				cwd: stdioConfig.cwd,
			});

			await client.connect(transport);
			try {
				return await fn(client);
			} finally {
				await client.close().catch(() => undefined);
			}
		}

		// HTTP transport
		const httpConfig = server.config as MarketplaceMcpConfigHttp;
		const resolvedHeaders = await resolveSecretReferences(httpConfig.headers);
		const transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), {
			requestInit: {
				headers: resolvedHeaders,
			},
		});
		await client.connect(transport);
		try {
			return await fn(client);
		} finally {
			await client.close().catch(() => undefined);
		}
	};

	// Timeout wrapper
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			run(),
			new Promise<T>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`Probe timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a SignetAppManifest from server metadata's `signet` block.
 * Returns null if no valid signet block is found.
 */
export function parseManifest(
	serverMetadata: unknown,
	serverName: string,
): SignetAppManifest | null {
	if (!isRecord(serverMetadata)) return null;

	// Look for `signet` or `signet.app` block
	const signetBlock = isRecord(serverMetadata.signet)
		? serverMetadata.signet
		: isRecord(serverMetadata["signet.app"])
			? serverMetadata["signet.app"]
			: null;

	if (!signetBlock) return null;

	// Name is required per spec
	const name =
		typeof signetBlock.name === "string" && signetBlock.name.trim().length > 0
			? signetBlock.name.trim()
			: serverName;

	const manifest: SignetAppManifest = {
		name,
		...(typeof signetBlock.icon === "string" && signetBlock.icon.trim().length > 0
			? { icon: signetBlock.icon.trim() }
			: {}),
		...(typeof signetBlock.ui === "string" && signetBlock.ui.trim().length > 0
			? { ui: signetBlock.ui.trim() }
			: {}),
		...(isRecord(signetBlock.defaultSize) &&
		typeof signetBlock.defaultSize.w === "number" &&
		typeof signetBlock.defaultSize.h === "number"
			? {
					defaultSize: {
						w: Math.max(1, Math.min(12, signetBlock.defaultSize.w)),
						h: Math.max(1, Math.min(12, signetBlock.defaultSize.h)),
					},
				}
			: {}),
		...(isRecord(signetBlock.events)
			? {
					events: {
						...(Array.isArray(signetBlock.events.subscribe)
							? {
									subscribe: signetBlock.events.subscribe.filter(
										(v: unknown): v is string => typeof v === "string",
									),
								}
							: {}),
						...(Array.isArray(signetBlock.events.emit)
							? {
									emit: signetBlock.events.emit.filter(
										(v: unknown): v is string => typeof v === "string",
									),
								}
							: {}),
					},
				}
			: {}),
		...(Array.isArray(signetBlock.menuItems)
			? {
					menuItems: signetBlock.menuItems.filter(
						(v: unknown): v is string => typeof v === "string",
					),
				}
			: {}),
		...(typeof signetBlock.dock === "boolean" ? { dock: signetBlock.dock } : {}),
	};

	return manifest;
}

// ---------------------------------------------------------------------------
// Auto-card generation
// ---------------------------------------------------------------------------

/**
 * Generate a fallback auto-card manifest from discovered tools and resources.
 * This gives every MCP server dashboard presence on install.
 */
export function generateAutoCard(
	tools: readonly AutoCardToolAction[],
	resources: readonly AutoCardResource[],
	serverName: string,
	icon?: string,
): AutoCardManifest {
	const hasAppResources = resources.some((r) => r.uri.startsWith("app://"));

	return {
		name: serverName,
		...(icon ? { icon } : {}),
		tools,
		resources,
		hasAppResources,
		defaultSize: DEFAULT_APP_SIZE,
	};
}

// ---------------------------------------------------------------------------
// Server probing
// ---------------------------------------------------------------------------

/**
 * Probe an installed MCP server to discover its tools, resources, and
 * any declared Signet manifest.
 *
 * This is called on install. If the server is unreachable, returns a
 * failed result with an auto-card containing zero tools — the server
 * can be re-probed when it comes online.
 */
export async function probeServer(
	server: InstalledMarketplaceMcpServer,
): Promise<McpProbeResult> {
	const now = new Date().toISOString();

	try {
		const probeData = await withProbeClient(server, async (client) => {
			// 1. List tools
			const toolsResult = (await client.listTools()) as {
				tools?: Array<{
					name: string;
					description?: string;
					inputSchema?: unknown;
					annotations?: { readOnlyHint?: boolean };
				}>;
			};
			const rawTools = toolsResult.tools ?? [];

			// 2. List resources (may not be supported by all servers)
			let rawResources: Array<{
				uri: string;
				name: string;
				description?: string;
				mimeType?: string;
			}> = [];
			try {
				const resourcesResult = (await client.listResources()) as {
					resources?: Array<{
						uri: string;
						name: string;
						description?: string;
						mimeType?: string;
					}>;
				};
				rawResources = resourcesResult.resources ?? [];
			} catch {
				// Resources not supported — that's fine
				logger.debug("probe", `Server ${server.id} does not support listResources`);
			}

			// 3. Try to get server info/metadata for signet block
			let serverMetadata: unknown = null;
			try {
				// The MCP SDK client may expose server info after connection
				const serverInfo = (client as unknown as { getServerVersion?: () => unknown })
					.getServerVersion?.();
				if (isRecord(serverInfo)) {
					serverMetadata = serverInfo;
				}
			} catch {
				// No server metadata available
			}

			// Also check if the server exposes metadata via a resource
			if (!serverMetadata) {
				try {
					// Convention: some servers expose metadata at signet://manifest
					const metaResource = rawResources.find(
						(r) =>
							r.uri === "signet://manifest" ||
							r.uri === "signet://app" ||
							r.name === "signet-manifest",
					);
					if (metaResource) {
						const content = await client.readResource({ uri: metaResource.uri });
						if (
							isRecord(content) &&
							Array.isArray(content.contents) &&
							content.contents.length > 0
						) {
							const firstContent = content.contents[0] as Record<string, unknown>;
							if (typeof firstContent?.text === "string") {
								try {
									serverMetadata = JSON.parse(firstContent.text);
								} catch {
									// Not valid JSON
								}
							}
						}
					}
				} catch {
					// Resource read failed — that's fine
				}
			}

			return { rawTools, rawResources, serverMetadata };
		});

		// Parse tools into AutoCardToolAction format
		const tools: AutoCardToolAction[] = probeData.rawTools
			.filter((t) => typeof t.name === "string" && t.name.length > 0)
			.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				readOnly: t.annotations?.readOnlyHint === true,
				inputSchema: t.inputSchema ?? {},
			}));

		// Parse resources into AutoCardResource format
		const resources: AutoCardResource[] = probeData.rawResources
			.filter((r) => typeof r.uri === "string" && r.uri.length > 0)
			.map((r) => ({
				uri: r.uri,
				name: r.name ?? r.uri,
				...(r.description ? { description: r.description } : {}),
				...(r.mimeType ? { mimeType: r.mimeType } : {}),
			}));

		// Try to extract declared manifest
		const declaredManifest = parseManifest(probeData.serverMetadata, server.name);

		// Always generate auto-card (used as fallback or when no UI)
		const autoCard = generateAutoCard(tools, resources, server.name);

		const hasAppResources = resources.some((r) => r.uri.startsWith("app://"));

		logger.info("probe", `Probed server ${server.id}: ${tools.length} tools, ${resources.length} resources`, {
			hasDeclaredManifest: !!declaredManifest,
			hasAppResources,
		});

		return {
			serverId: server.id,
			ok: true,
			declaredManifest: declaredManifest ?? undefined,
			autoCard,
			toolCount: tools.length,
			resourceCount: resources.length,
			hasAppResources,
			probedAt: now,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.warn("probe", `Failed to probe server ${server.id}: ${msg}`);

		// Return a failed result with empty auto-card
		// Per spec recommendation: install with auto-card only,
		// show "reconnecting" state, auto-upgrade when server appears
		return {
			serverId: server.id,
			ok: false,
			error: msg,
			autoCard: generateAutoCard([], [], server.name),
			toolCount: 0,
			resourceCount: 0,
			hasAppResources: false,
			probedAt: now,
		};
	}
}

// ---------------------------------------------------------------------------
// Persistence — probe results and app tray
// ---------------------------------------------------------------------------

/**
 * Store a probe result to disk and update the app tray index.
 */
export function storeProbeResult(result: McpProbeResult): void {
	ensureManifestsDir();

	// Write per-server probe result
	const manifestPath = join(getManifestsDir(), `${result.serverId}.json`);
	writeFileSync(manifestPath, JSON.stringify(result, null, 2));

	// Update app tray index
	const tray = loadAppTray();
	const now = new Date().toISOString();

	const existingIndex = tray.findIndex((e) => e.id === result.serverId);

	// Build the effective manifest (declared takes precedence, auto-card is fallback)
	const effectiveManifest: SignetAppManifest = result.declaredManifest ?? {
		name: result.autoCard.name,
		...(result.autoCard.icon ? { icon: result.autoCard.icon } : {}),
		defaultSize: result.autoCard.defaultSize,
	};

	const entry: AppTrayEntry = {
		id: result.serverId,
		name: effectiveManifest.name,
		icon: effectiveManifest.icon,
		state: result.declaredManifest?.dock ? "dock" : "tray",
		manifest: effectiveManifest,
		autoCard: result.autoCard,
		hasDeclaredManifest: !!result.declaredManifest,
		createdAt: existingIndex >= 0 ? tray[existingIndex].createdAt : now,
		updatedAt: now,
	};

	if (existingIndex >= 0) {
		tray[existingIndex] = entry;
	} else {
		tray.push(entry);
	}

	writeFileSync(getAppTrayPath(), JSON.stringify(tray, null, 2));

	logger.info("probe", `Stored probe result for ${result.serverId}`, {
		hasDeclaredManifest: !!result.declaredManifest,
		state: entry.state,
		toolCount: result.toolCount,
	});
}

/**
 * Load the app tray index from disk.
 */
export function loadAppTray(): AppTrayEntry[] {
	const path = getAppTrayPath();
	if (!existsSync(path)) return [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(item): item is AppTrayEntry =>
				isRecord(item) &&
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				typeof item.state === "string",
		);
	} catch {
		return [];
	}
}

/**
 * Load a stored probe result for a specific server.
 */
export function loadProbeResult(serverId: string): McpProbeResult | null {
	const path = join(getManifestsDir(), `${serverId}.json`);
	if (!existsSync(path)) return null;

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(raw) || typeof raw.serverId !== "string") return null;
		return raw as unknown as McpProbeResult;
	} catch {
		return null;
	}
}

/**
 * Remove a server's probe result and app tray entry.
 * Called when a server is uninstalled.
 */
export function removeProbeResult(serverId: string): void {
	// Remove probe result file
	const manifestPath = join(getManifestsDir(), `${serverId}.json`);
	try {
		if (existsSync(manifestPath)) {
			unlinkSync(manifestPath);
		}
	} catch {
		logger.warn("probe", `Failed to remove probe result for ${serverId}`);
	}

	// Remove from app tray
	const tray = loadAppTray();
	const filtered = tray.filter((e) => e.id !== serverId);
	if (filtered.length !== tray.length) {
		writeFileSync(getAppTrayPath(), JSON.stringify(filtered, null, 2));
	}
}

/**
 * Re-probe a server. Useful when a previously unreachable server comes online.
 */
export async function reprobeServer(
	server: InstalledMarketplaceMcpServer,
): Promise<McpProbeResult> {
	const result = await probeServer(server);
	storeProbeResult(result);
	return result;
}
