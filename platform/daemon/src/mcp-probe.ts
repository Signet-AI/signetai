import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { DEFAULT_APP_SIZE, resolveDefaultBasePath } from "@signet/core";
import { createEvent, eventBus } from "./event-bus.js";
import { logger } from "./logger.js";
import { withMarketplaceMcpPermit, withMarketplaceMcpTimeout } from "./marketplace-client-budget.js";
import type { InstalledMarketplaceMcpServer } from "./routes/marketplace.js";
import { getSecret } from "./secrets.js";
import { deleteCachedWidget, loadCachedWidget } from "./widget-gen.js";

function getAgentsDir(): string {
	return resolveDefaultBasePath();
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

const SECRET_REF_PREFIX = "secret://";

function parseSecretReference(value: string): string | null {
	if (!value.startsWith(SECRET_REF_PREFIX)) return null;
	const name = value.slice(SECRET_REF_PREFIX.length).trim();
	return name || null;
}

async function resolveSecretReferences(values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
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

async function withProbeClient<T>(
	server: InstalledMarketplaceMcpServer,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const timeoutMs = Math.min(server.config.timeoutMs, 30_000);
	return withMarketplaceMcpPermit(timeoutMs, async (permit, remainingTimeoutMs) => {
		const client = new Client({
			name: "signet-os-probe",
			version: "0.1.0",
		});
		let closePromise: Promise<void> | null = null;
		const close = (): Promise<void> => {
			if (!closePromise) {
				closePromise = client.close().catch(() => undefined);
			}
			return closePromise;
		};

		const run = async (): Promise<T> => {
			if (server.config.transport === "stdio") {
				const runtimeEnv: Record<string, string> = {};
				for (const [k, v] of Object.entries(process.env)) {
					if (typeof v === "string") runtimeEnv[k] = v;
				}
				const resolvedEnv = await resolveSecretReferences(server.config.env);
				const transport = new StdioClientTransport({
					command: server.config.command,
					args: [...server.config.args],
					env: { ...runtimeEnv, ...resolvedEnv },
					cwd: server.config.cwd,
				});

				permit.markProcessStarted();
				await client.connect(transport);
				return fn(client);
			}

			const resolvedHeaders = await resolveSecretReferences(server.config.headers);
			const transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
				requestInit: {
					headers: resolvedHeaders,
				},
			});
			await client.connect(transport);
			return fn(client);
		};

		try {
			return await withMarketplaceMcpTimeout(run(), remainingTimeoutMs, `Probe ${server.id}`, close);
		} finally {
			await close();
		}
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseManifest(serverMetadata: unknown, serverName: string): SignetAppManifest | null {
	if (!isRecord(serverMetadata)) return null;
	const signetBlock = isRecord(serverMetadata.signet)
		? serverMetadata.signet
		: isRecord(serverMetadata["signet.app"])
			? serverMetadata["signet.app"]
			: null;

	if (!signetBlock) return null;
	const name =
		typeof signetBlock.name === "string" && signetBlock.name.trim().length > 0 ? signetBlock.name.trim() : serverName;
	let validatedIcon: string | undefined;
	if (typeof signetBlock.icon === "string" && signetBlock.icon.trim().length > 0) {
		try {
			const iconUrl = new URL(signetBlock.icon.trim());
			if (iconUrl.protocol === "https:" || iconUrl.protocol === "http:") {
				validatedIcon = signetBlock.icon.trim();
			} else {
				logger.warn("probe", `Rejected icon URL with non-HTTP scheme: ${iconUrl.protocol}`);
			}
		} catch {
			logger.warn("probe", `Rejected invalid icon URL: ${signetBlock.icon}`);
		}
	}

	const manifest: SignetAppManifest = {
		name,
		...(validatedIcon ? { icon: validatedIcon } : {}),
		...(() => {
			if (typeof signetBlock.ui === "string" && signetBlock.ui.trim().length > 0) {
				try {
					const uiUrl = new URL(signetBlock.ui.trim());
					if (uiUrl.protocol === "https:" || uiUrl.protocol === "http:") {
						return { ui: signetBlock.ui.trim() };
					}
					logger.warn("probe", `Rejected ui URL with non-HTTP scheme: ${uiUrl.protocol}`);
				} catch {
					logger.warn("probe", `Rejected invalid ui URL: ${signetBlock.ui}`);
				}
			}
			return {};
		})(),
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
									subscribe: signetBlock.events.subscribe.filter((v: unknown): v is string => typeof v === "string"),
								}
							: {}),
						...(Array.isArray(signetBlock.events.emit)
							? {
									emit: signetBlock.events.emit.filter((v: unknown): v is string => typeof v === "string"),
								}
							: {}),
					},
				}
			: {}),
		...(Array.isArray(signetBlock.menuItems)
			? {
					menuItems: signetBlock.menuItems.filter((v: unknown): v is string => typeof v === "string"),
				}
			: {}),
		...(typeof signetBlock.dock === "boolean" ? { dock: signetBlock.dock } : {}),
		...(() => {
			if (typeof signetBlock.html === "string" && signetBlock.html.trim().length > 0) {
				const raw = signetBlock.html.trim();
				if (/<script\s+src\s*=/i.test(raw)) {
					logger.warn("probe", "Rejected manifest HTML with external script src");
					return {};
				}
				return { html: raw };
			}
			return {};
		})(),
	};

	return manifest;
}
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
export async function probeServer(server: InstalledMarketplaceMcpServer): Promise<McpProbeResult> {
	const now = new Date().toISOString();

	try {
		const probeData = await withProbeClient(server, async (client) => {
			const toolsResult = (await client.listTools()) as {
				tools?: Array<{
					name: string;
					description?: string;
					inputSchema?: unknown;
					annotations?: { readOnlyHint?: boolean };
				}>;
			};
			const rawTools = toolsResult.tools ?? [];
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
				logger.debug("probe", `Server ${server.id} does not support listResources`);
			}
			let serverMetadata: unknown = null;
			try {
				const serverInfo = (client as unknown as { getServerVersion?: () => unknown }).getServerVersion?.();
				if (isRecord(serverInfo)) {
					serverMetadata = serverInfo;
				}
			} catch {}
			if (!serverMetadata) {
				try {
					const metaResource = rawResources.find(
						(r) => r.uri === "signet://manifest" || r.uri === "signet://app" || r.name === "signet-manifest",
					);
					if (metaResource) {
						const content = await client.readResource({ uri: metaResource.uri });
						if (isRecord(content) && Array.isArray(content.contents) && content.contents.length > 0) {
							const firstContent = content.contents[0] as Record<string, unknown>;
							if (typeof firstContent?.text === "string") {
								try {
									serverMetadata = JSON.parse(firstContent.text);
								} catch {}
							}
						}
					}
				} catch {}
			}

			return { rawTools, rawResources, serverMetadata };
		});
		const tools: AutoCardToolAction[] = probeData.rawTools
			.filter((t) => typeof t.name === "string" && t.name.length > 0)
			.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				readOnly: t.annotations?.readOnlyHint === true,
				inputSchema: t.inputSchema ?? {},
			}));
		const resources: AutoCardResource[] = probeData.rawResources
			.filter((r) => typeof r.uri === "string" && r.uri.length > 0)
			.map((r) => ({
				uri: r.uri,
				name: r.name ?? r.uri,
				...(r.description ? { description: r.description } : {}),
				...(r.mimeType ? { mimeType: r.mimeType } : {}),
			}));
		const declaredManifest = parseManifest(probeData.serverMetadata, server.name);
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
export function storeProbeResult(result: McpProbeResult): void {
	ensureManifestsDir();
	const manifestPath = join(getManifestsDir(), `${result.serverId}.json`);
	writeFileSync(manifestPath, JSON.stringify(result, null, 2));
	const tray = loadAppTray();
	const now = new Date().toISOString();

	const existingIndex = tray.findIndex((e) => e.id === result.serverId);
	const oldEntry = existingIndex >= 0 ? tray[existingIndex] : null;
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
	if (oldEntry) {
		const oldTools = new Set(oldEntry.autoCard.tools.map((t) => t.name));
		const newTools = new Set(result.autoCard.tools.map((t) => t.name));
		const changed = oldTools.size !== newTools.size || [...oldTools].some((n) => !newTools.has(n));
		if (changed && loadCachedWidget(result.serverId)) {
			deleteCachedWidget(result.serverId);
			eventBus.emit(createEvent("system", "widget.invalidated", { serverId: result.serverId }));
			logger.info("probe", `Invalidated cached widget for ${result.serverId} (tools changed)`);
		}
	}
}
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
export function removeProbeResult(serverId: string): void {
	const manifestPath = join(getManifestsDir(), `${serverId}.json`);
	try {
		if (existsSync(manifestPath)) {
			unlinkSync(manifestPath);
		}
	} catch {
		logger.warn("probe", `Failed to remove probe result for ${serverId}`);
	}
	const tray = loadAppTray();
	const filtered = tray.filter((e) => e.id !== serverId);
	if (filtered.length !== tray.length) {
		writeFileSync(getAppTrayPath(), JSON.stringify(filtered, null, 2));
	}
}
export async function reprobeServer(server: InstalledMarketplaceMcpServer): Promise<McpProbeResult> {
	const result = await probeServer(server);
	storeProbeResult(result);
	return result;
}
