import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { connectorRegistryKey } from "../lib/connector-registry.js";
import { attemptAsync } from "@signet/core";
import type { Command } from "commander";
import { HermesAgentConnector } from "@signet/connector-hermes-agent";
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { CodexConnector } from "@signet/connector-codex";
import { ForgeConnector } from "@signet/connector-forge";
import { GeminiConnector } from "@signet/connector-gemini";
import { KimiConnector } from "@signet/connector-kimi";
import { MuseCodeConnector } from "@signet/connector-muse-code";
import { OpenCodeConnector } from "@signet/connector-opencode";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { OhMyPiConnector } from "@signet/connector-oh-my-pi";
import { PiConnector } from "@signet/connector-pi";
import {
	ConnectorRegistry,
	DurableOutbox,
	NodeTransport,
	resolveTarget,
	writeKeyFile,
	readKeyFile,
} from "../../../../libs/sdk/src/node.js";
import { SignetApiError, SignetUnauthorizedError } from "../../../../libs/sdk/src/index.js";
import { runConnectorMcp } from "../lib/connector-mcp.js";
import { inspectConnectorFiles } from "../lib/connector-doctor.js";
import { reportAuthError, type AuthCommandDeps } from "./auth.js";

interface ConnectorInstallOptions {
	url?: string;
	apiKeyStdin?: boolean;
	agentId?: string;
	path?: string;
	profile?: string;
	agent?: string;
	memory?: "isolated" | "shared" | "group";
	group?: string;
	json?: boolean;
}
interface ConnectorDeps extends AuthCommandDeps {
	readonly agentsDir: string;
}
export const supportedHarnesses = [
	"claude-code",
	"codex",
	"forge",
	"gemini",
	"hermes-agent",
	"kimi",
	"muse-code",
	"opencode",
	"openclaw",
	"oh-my-pi",
	"pi",
] as const;
function connectorFor(harness: string, profile?: string) {
	switch (harness) {
		case "claude-code":
			return new ClaudeCodeConnector();
		case "codex":
			return new CodexConnector();
		case "forge":
			return new ForgeConnector();
		case "gemini":
			return new GeminiConnector();
		case "hermes-agent":
			return new HermesAgentConnector(profile ? { profile } : undefined);
		case "kimi":
			return new KimiConnector();
		case "muse-code":
			return new MuseCodeConnector();
		case "opencode":
			return new OpenCodeConnector();
		case "openclaw":
			return new OpenClawConnector();
		case "oh-my-pi":
			return new OhMyPiConnector();
		case "pi":
			return new PiConnector();
		default:
			throw new Error(`Unsupported harness: ${harness}`);
	}
}
function canonical(harness: string): string {
	return harness === "hermes" ? "hermes-agent" : harness;
}
interface Identity {
	mode: string;
	credential?: { kind?: string; deviceId?: string; expiresAt?: string };
}
interface IssuedKey {
	key: { id: string; agentId?: string; deviceId?: string; expiresAt: string };
	secret: string;
}
async function revokeConnectorKey(
	entry: { url: string; keyId?: string } | undefined,
	deps: ConnectorDeps,
): Promise<void> {
	if (!entry?.keyId) return;
	const target = await resolveTarget({ ...deps, flagUrl: entry.url });
	const transport = new NodeTransport(target, { env: deps.env });
	try {
		await transport.request("DELETE", `/api/auth/connector-keys/${encodeURIComponent(entry.keyId)}`);
	} catch (error) {
		if (!(error instanceof SignetApiError) || error.status !== 404) throw error;
	}
	const response = await transport.get<{ keys: { id: string; revoked_at?: string | null }[] }>(
		"/api/auth/connector-keys",
	);
	if (!Array.isArray(response.keys) || response.keys.some((key) => key.id === entry.keyId && !key.revoked_at))
		throw new Error("Connector revocation could not be verified; local state was retained");
}
async function installConnector(raw: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	const harness = canonical(raw);
	const installer = connectorFor(harness, options.profile);
	const target = await resolveTarget({ ...deps, flagUrl: options.url ?? deps.flagUrl });
	const transport = new NodeTransport(target, { env: deps.env });
	const identity = await transport.get<Identity>("/api/auth/whoami");
	const registry = new ConnectorRegistry(deps);
	const registryKey = connectorRegistryKey(
		harness,
		harness === "hermes-agent" ? dirname(installer.getConfigPath()) : undefined,
		deps.env,
	);
	const previous = (await registry.read())[registryKey];
	const provision = identity.mode !== "local" && (target.remote || identity.mode === "team");
	if (provision && (identity.credential?.kind !== "session" || !identity.credential.deviceId))
		throw new SignetUnauthorizedError("missing_credential");
	await revokeConnectorKey(previous, deps);
	let issued: IssuedKey | undefined;
	if (provision) {
		issued = await transport.post<IssuedKey>("/api/auth/connector-keys", {
			harness,
			deviceId: identity.credential?.deviceId,
			...((options.agent ?? options.agentId) ? { agentId: options.agent ?? options.agentId } : {}),
		});
	}
	const keyFile = issued ? await writeKeyFile(target.origin, registryKey, issued.secret, deps) : undefined;
	const agentId =
		issued?.key.agentId ??
		options.agent ??
		options.agentId ??
		(harness === "hermes-agent" ? options.profile : undefined);
	await registry.set(registryKey, {
		url: target.url,
		...(keyFile ? { keyFile } : {}),
		...(agentId ? { agentId } : {}),
		...(issued ? { keyId: issued.key.id, deviceId: issued.key.deviceId ?? identity.credential?.deviceId } : {}),
	});
	const previousUrl = process.env.SIGNET_DAEMON_URL;
	process.env.SIGNET_DAEMON_URL = target.url;
	let result: Awaited<ReturnType<typeof installer.install>>;
	try {
		const path = options.path ?? deps.agentsDir;
		result =
			installer instanceof HermesAgentConnector
				? await installer.install(path, {
						agentId,
						memoryPolicy: options.memory,
						policyGroup: options.group,
					})
				: await installer.install(path);
	} finally {
		if (previousUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
		else process.env.SIGNET_DAEMON_URL = previousUrl;
	}
	if (!result.success) throw new Error(`${result.message}: ${(result.warnings ?? []).join("; ")}`);
	if (previous?.keyFile && previous.keyFile !== keyFile) await rm(previous.keyFile, { force: true });
	const registered = (await registry.read())[registryKey];
	if (registered?.url !== target.url || registered.keyId !== issued?.key.id)
		throw new Error("Connector registry readback failed");
	const connected = new NodeTransport(
		keyFile
			? { ...target, harness: registryKey, credential: { source: "key-file", get: () => readKeyFile(keyFile) } }
			: { ...target, harness: registryKey },
		{ env: deps.env },
	);
	await connected.get("/api/auth/whoami");
	await connected.flush();
	console.log(
		JSON.stringify(
			{
				harness,
				url: target.url,
				agentId,
				deviceId: issued?.key.deviceId,
				keyId: issued?.key.id,
				expiresAt: issued?.key.expiresAt,
				installed: true,
			},
			null,
			options.json ? undefined : 2,
		),
	);
}
async function disconnect(raw: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	const harness = canonical(raw);
	const registry = new ConnectorRegistry(deps);
	const installer = connectorFor(harness, options.profile);
	const registryKey = connectorRegistryKey(
		harness,
		harness === "hermes-agent" ? dirname(installer.getConfigPath()) : undefined,
		deps.env,
	);
	const entry = (await registry.read())[registryKey];
	await revokeConnectorKey(entry, deps);
	const result = await installer.uninstall();
	for (const path of result.filesRemoved) {
		try {
			await stat(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		throw new Error("Harness integration removal could not be verified; registry state was retained");
	}
	if (entry?.keyFile) await rm(entry.keyFile, { force: true });
	await registry.remove(registryKey);
	if ((await registry.read())[registryKey]) throw new Error("Connector registry removal could not be verified");
	console.log(JSON.stringify({ harness, disconnected: true }));
}
function addOptions(command: Command): Command {
	return command
		.option("--url <url>", "Signet instance URL")
		.option("--api-key-stdin", "Read a key from stdin, never argv")
		.option("--agent <id>", "Connector agent")
		.option("--agent-id <id>", "Connector agent")
		.option("--path <path>", "Signet workspace path")
		.option("--profile <name>", "Hermes profile")
		.option("--json", "Machine-readable output");
}
export function registerConnectorCommands(program: Command, deps: ConnectorDeps): void {
	const action =
		(run: (harness: string, options: ConnectorInstallOptions, deps: ConnectorDeps) => Promise<void>) =>
		async (harness: string, options: ConnectorInstallOptions) => {
			try {
				let flagKey: string | undefined;
				if (options.apiKeyStdin) {
					if (process.stdin.isTTY) throw new Error("--api-key-stdin requires piped input");
					let text = "";
					for await (const chunk of process.stdin) {
						text += String(chunk);
						if (text.length > 65536) throw new Error("Key input exceeds limit");
					}
					flagKey = text.trim();
					if (!flagKey || /[\r\n]/.test(flagKey)) throw new Error("Invalid key input");
				}
				await run(harness, options, { ...deps, ...(flagKey ? { flagKey } : {}) });
			} catch (error) {
				reportAuthError(error, options.json);
			}
		};
	const connector = program.command("connector").description("Manage harness credentials and integrations");
	connector
		.command("mcp <harness>")
		.description("Proxy MCP using the harness registry credential")
		.action(async (harness: string) => {
			try {
				await runConnectorMcp(connectorRegistryKey(canonical(harness), undefined, deps.env), deps);
			} catch (error) {
				reportAuthError(error);
			}
		});
	addOptions(program.command("connect <harness>")).action(action(installConnector));
	addOptions(connector.command("install <harness>")).action(action(installConnector));
	addOptions(connector.command("rotate <harness>")).action(
		action(async (harness, opts, ctx) => {
			const name = canonical(harness);
			const installer = connectorFor(name, opts.profile);
			const registryKey = connectorRegistryKey(
				name,
				name === "hermes-agent" ? dirname(installer.getConfigPath()) : undefined,
				ctx.env,
			);
			const entry = (await new ConnectorRegistry(ctx).read())[registryKey];
			if (!entry) throw new Error("Connector is not connected");
			await installConnector(harness, { ...opts, url: entry.url, agent: opts.agent ?? entry.agentId }, ctx);
		}),
	);
	addOptions(program.command("disconnect <harness>")).action(action(disconnect));
	connector
		.command("list")
		.option("--json")
		.action(async (opts: ConnectorInstallOptions) => {
			try {
				const entries = await new ConnectorRegistry(deps).read();
				const rows = [];
				for (const [harness, entry] of Object.entries(entries)) {
					try {
						const identity = await new NodeTransport(await resolveTarget({ ...deps, harness }), {
							env: deps.env,
						}).get<Identity>("/api/auth/whoami");
						const metadata =
							identity.mode === "local"
								? undefined
								: await attemptAsync(async () => {
										const sessionTarget = await resolveTarget({ ...deps, flagUrl: entry.url });
										const response = await new NodeTransport(sessionTarget, { env: deps.env }).get<{
											keys: { id: string; last_used_at?: string | null; expires_at?: string | null }[];
										}>("/api/auth/connector-keys");
										return Array.isArray(response.keys)
											? response.keys.find((key) => key.id === entry.keyId)
											: undefined;
									});
						const expiry = metadata?.expires_at ?? identity.credential?.expiresAt;
						const status =
							identity.mode === "local"
								? "local"
								: expiry && Date.parse(expiry) <= Date.now()
									? "expired"
									: expiry && Date.parse(expiry) - Date.now() < 3 * 86400000
										? "expiring"
										: "valid";
						rows.push({
							harness,
							...entry,
							status,
							expiresAt: expiry ?? null,
							lastUsedAt: metadata?.last_used_at ?? null,
							metadataStatus: identity.mode === "local" ? "local" : metadata ? "available" : "unavailable",
						});
					} catch (error) {
						rows.push({
							harness,
							...entry,
							status:
								error instanceof SignetUnauthorizedError && ["expired", "revoked"].includes(error.reason)
									? error.reason
									: "unavailable",
							lastUsedAt: null,
						});
					}
				}
				console.log(JSON.stringify(rows, null, opts.json ? undefined : 2));
			} catch (error) {
				reportAuthError(error, opts.json);
			}
		});
	connector
		.command("doctor")
		.option("--json")
		.action(async (opts: ConnectorInstallOptions) => {
			try {
				const results = [];
				const inline = [];
				for (const harness of supportedHarnesses) {
					const files = await inspectConnectorFiles(connectorFor(harness).getConfigPath());
					if (files.inlineKeyFiles.length || files.scanIncomplete) inline.push({ harness, ...files });
				}
				for (const [harness, entry] of Object.entries(await new ConnectorRegistry(deps).read())) {
					const outbox = new DurableOutbox(entry.url, { env: deps.env, harness });
					try {
						if (entry.keyFile) await readKeyFile(entry.keyFile);
						const transport = new NodeTransport(await resolveTarget({ ...deps, harness }), { env: deps.env });
						const identity = await transport.get<Identity>("/api/auth/whoami");
						await transport.flush();
						const state = await outbox.status();
						results.push({
							harness,
							url: entry.url,
							healthy: state.pending === 0 && state.quarantined === 0,
							mode: identity.mode,
							outbox: state,
						});
					} catch (error) {
						results.push({
							harness,
							healthy: false,
							reason:
								error instanceof SignetUnauthorizedError
									? error.reason
									: error instanceof Error
										? error.name
										: "inspection_failed",
							outbox: await outbox.status(),
						});
					}
				}
				let legacy: { status: string; unassigned?: number } = { status: "unavailable" };
				try {
					const response = await new NodeTransport(await resolveTarget(deps), { env: deps.env }).get<unknown>(
						"/api/org/keys",
						{ legacy: "1" },
					);
					const keys =
						typeof response === "object" && response !== null && "keys" in response && Array.isArray(response.keys)
							? response.keys
							: null;
					if (keys)
						legacy = {
							status: "checked",
							unassigned: keys.filter(
								(key: unknown) => typeof key === "object" && key !== null && "userId" in key && key.userId === null,
							).length,
						};
				} catch (error) {
					legacy = { status: error instanceof SignetUnauthorizedError ? "login_required" : "unavailable" };
				}
				if (inline.length || results.some((result) => !result.healthy) || legacy.unassigned) process.exitCode = 1;
				console.log(
					JSON.stringify(
						{ connectors: results, inlineKeys: inline, legacyKeys: legacy },
						null,
						opts.json ? undefined : 2,
					),
				);
			} catch (error) {
				reportAuthError(error, opts.json);
			}
		});
}
