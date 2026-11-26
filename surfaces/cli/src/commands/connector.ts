import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PendingRevokes, type PendingRevoke } from "../lib/connector-revocations.js";
import { snapshotInstallation } from "../lib/connector-installation.js";
import {
	atomicPrivateWrite,
	configDirectory,
	identifier,
	withFileLock,
} from "../../../../libs/sdk/src/node/storage.js";
import { connectorRegistryKey } from "../lib/connector-registry.js";
import { attemptAsync, expandHome } from "@signet/core";
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
	connectorKeyFilePath,
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
	purgeOutbox?: boolean;
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
const harnessAliases: ReadonlyMap<string, string> = new Map([["hermes", "hermes-agent"]]);
function canonicalHarness(harness: string): string {
	return harnessAliases.get(harness) ?? harness;
}
interface Identity {
	mode: string;
	credential?: {
		kind?: string;
		keyKind?: string;
		harness?: string;
		id?: string;
		agentId?: string;
		deviceId?: string;
		expiresAt?: string;
	};
}
interface IssuedKey {
	key: { id: string; agentId?: string; deviceId?: string; expiresAt?: string };
	secret: string;
}
async function revokeConnectorKey(
	entry: { url: string; keyId?: string } | undefined,
	deps: ConnectorDeps,
): Promise<void> {
	if (!entry?.keyId) return;
	const target = await resolveTarget({ ...deps, flagKey: undefined, flagUrl: entry.url });
	const transport = new NodeTransport(target, { env: deps.env, retries: 0, timeoutMs: 5000 });
	try {
		await transport.request("DELETE", `/api/auth/connector-keys/${encodeURIComponent(entry.keyId)}`);
	} catch (error) {
		if (!(error instanceof SignetApiError) || error.status !== 404) throw error;
	}
	const response = await transport.get<{ keys: { id: string; revoked_at?: string | null }[] }>(
		"/api/auth/connector-keys",
	);
	const verified = Array.isArray(response.keys) ? response.keys.find((key) => key.id === entry.keyId) : undefined;
	if (!verified?.revoked_at) throw new Error("Connector revocation could not be verified; it remains pending");
}
function withHarnessLock<T>(harness: string, deps: ConnectorDeps, run: () => Promise<T>): Promise<T> {
	return withFileLock(join(configDirectory(deps), "connector-locks", `${identifier(harness)}.lock`), run);
}
async function finishRevocation(
	record: PendingRevoke | undefined,
	deps: ConnectorDeps,
	json = false,
): Promise<"none" | "revoked" | "pending"> {
	if (!record) return "none";
	const pending = new PendingRevokes(deps);
	await pending.add(record);
	try {
		await revokeConnectorKey(record, deps);
		await pending.remove(record);
		return "revoked";
	} catch (error) {
		reportAuthError(error, json);
		return "pending";
	}
}
async function installConnector(raw: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	const harness = canonicalHarness(raw);
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
	const manual = deps.flagKey !== undefined;
	if (
		manual &&
		(identity.credential?.kind !== "api_key" ||
			identity.credential.keyKind !== "connector" ||
			identity.credential.harness !== harness ||
			!identity.credential.id ||
			!identity.credential.deviceId)
	)
		throw new Error(
			`--api-key-stdin requires a connector key bound to ${harness}; personal, session, and other-harness credentials are not accepted`,
		);
	if (
		manual &&
		identity.credential?.agentId &&
		(options.agent ?? options.agentId) &&
		identity.credential.agentId !== (options.agent ?? options.agentId)
	)
		throw new Error("The connector key is bound to a different agent");
	if (provision && !manual && (identity.credential?.kind !== "session" || !identity.credential.deviceId))
		throw new SignetUnauthorizedError("missing_credential");
	const path = expandHome(options.path ?? deps.agentsDir);
	if (!path.trim()) throw new Error("A non-empty workspace path is required");
	const restoreInstallation = await snapshotInstallation([...installer.getInstallPaths(), join(path, "AGENTS.md")]);
	const previousSecret = previous?.keyFile ? await readKeyFile(previous.keyFile) : undefined;
	let issued: IssuedKey | undefined;
	if (manual && deps.flagKey && identity.credential?.id) {
		issued = {
			secret: deps.flagKey,
			key: {
				id: identity.credential.id,
				deviceId: identity.credential.deviceId,
				agentId: identity.credential.agentId,
				expiresAt: identity.credential.expiresAt,
			},
		};
	} else if (provision) {
		issued = await transport.post<IssuedKey>("/api/auth/connector-keys", {
			harness,
			deviceId: identity.credential?.deviceId,
			...((options.agent ?? options.agentId) ? { agentId: options.agent ?? options.agentId } : {}),
		});
	}
	const keyFile = issued ? connectorKeyFilePath(target.origin, registryKey, deps) : undefined;
	const agentId = issued?.key.agentId ?? options.agent ?? options.agentId;
	const oldRevoke =
		previous?.keyId && (previous.keyId !== issued?.key.id || previous.url !== target.url)
			? { harness: registryKey, url: previous.url, keyId: previous.keyId }
			: undefined;
	const pending = new PendingRevokes(deps);
	let swapping = false;
	try {
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_DAEMON_URL = target.url;
		let result: Awaited<ReturnType<typeof installer.install>>;
		try {
			result =
				installer instanceof HermesAgentConnector
					? await installer.install(path, { agentId, memoryPolicy: options.memory, policyGroup: options.group })
					: await installer.install(path);
		} finally {
			if (previousUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousUrl;
		}
		if (!result.success) throw new Error(`${result.message}: ${(result.warnings ?? []).join("; ")}`);
		if (oldRevoke) await pending.add(oldRevoke);
		swapping = true;
		if (issued) await writeKeyFile(target.origin, registryKey, issued.secret, deps);
		await registry.set(registryKey, {
			url: target.url,
			...(keyFile ? { keyFile } : {}),
			...(agentId ? { agentId } : {}),
			...(issued ? { keyId: issued.key.id, deviceId: issued.key.deviceId ?? identity.credential?.deviceId } : {}),
		});
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
	} catch (error) {
		const failures: unknown[] = [];
		async function recover(run: () => Promise<void>): Promise<void> {
			try {
				await run();
			} catch (failure) {
				failures.push(failure);
			}
		}
		if (swapping) {
			if (previousSecret && previous?.keyFile && previous.keyFile === keyFile) {
				const previousPath = previous.keyFile;
				await recover(() => atomicPrivateWrite(previousPath, previousSecret));
			}
			await recover(() => (previous ? registry.set(registryKey, previous) : registry.remove(registryKey)));
			if (keyFile && keyFile !== previous?.keyFile) await recover(() => rm(keyFile, { force: true }));
		}
		await recover(restoreInstallation);
		if (oldRevoke) await recover(() => pending.remove(oldRevoke));
		if (issued && !manual) {
			const orphan = { harness: registryKey, url: target.url, keyId: issued.key.id };
			await pending.add(orphan);
			if (!failures.length) await finishRevocation(orphan, deps, options.json);
		}
		if (failures.length)
			throw new AggregateError(
				[error, ...failures],
				"Connector install failed; rollback incomplete; local recovery is required",
			);
		throw error;
	}
	if (previous?.keyFile && previous.keyFile !== keyFile) await rm(previous.keyFile, { force: true });
	const connected = new NodeTransport(
		await resolveTarget({ ...deps, flagUrl: undefined, flagKey: undefined, harness: registryKey }),
		{ env: deps.env },
	);
	try {
		await connected.flush();
	} catch (error) {
		reportAuthError(error, options.json);
	}
	const revocation = await finishRevocation(oldRevoke, deps, options.json);
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
				revocation,
			},
			null,
			options.json ? undefined : 2,
		),
	);
}
async function disconnect(raw: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	const harness = canonicalHarness(raw);
	const registry = new ConnectorRegistry(deps);
	const installer = connectorFor(harness, options.profile);
	const registryKey = connectorRegistryKey(
		harness,
		harness === "hermes-agent" ? dirname(installer.getConfigPath()) : undefined,
		deps.env,
	);
	const entry = (await registry.read())[registryKey];
	let outbox: DurableOutbox | undefined;
	if (options.purgeOutbox) {
		if (!entry && !options.url) throw new Error("No saved connector target; pass --url to select the retained outbox");
		const target = await resolveTarget({ ...deps, harness: registryKey, flagUrl: options.url ?? entry?.url });
		if (entry && target.url !== entry.url)
			throw new Error("The requested outbox target differs from the connected target");
		outbox = new DurableOutbox(target.origin, { env: deps.env, harness: registryKey });
	}
	const pending = entry?.keyId ? { harness: registryKey, url: entry.url, keyId: entry.keyId } : undefined;
	if (pending) await new PendingRevokes(deps).add(pending);
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
	if (installer.isInstalled())
		throw new Error("Harness integration removal could not be verified; registry state was retained");
	if (outbox) await outbox.purge();
	if (entry?.keyFile) await rm(entry.keyFile, { force: true });
	await registry.remove(registryKey);
	if ((await registry.read())[registryKey]) throw new Error("Connector registry removal could not be verified");
	const revocation = await finishRevocation(pending, deps, options.json);
	console.log(
		JSON.stringify({
			harness,
			disconnected: true,
			revocation,
			outbox: options.purgeOutbox ? "purged" : "retained",
			message: options.purgeOutbox
				? "Session evidence outbox purged"
				: "Session evidence kept; use --purge-outbox to delete it (pass --url if already disconnected)",
		}),
	);
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
				const name = canonicalHarness(harness);
				const installer = connectorFor(name, options.profile);
				const registryKey = connectorRegistryKey(
					name,
					name === "hermes-agent" ? dirname(installer.getConfigPath()) : undefined,
					deps.env,
				);
				await withHarnessLock(registryKey, deps, () =>
					run(harness, options, { ...deps, ...(flagKey ? { flagKey } : {}) }),
				);
			} catch (error) {
				reportAuthError(
					error,
					options.json,
					options.apiKeyStdin
						? "Supplied connector key was rejected; provide a valid harness-bound connector key"
						: undefined,
				);
			}
		};
	const connector = program.command("connector").description("Manage harness credentials and integrations");
	connector
		.command("mcp <harness>")
		.description("Proxy MCP using the harness registry credential")
		.action(async (harness: string) => {
			try {
				await runConnectorMcp(connectorRegistryKey(canonicalHarness(harness), undefined, deps.env), deps);
			} catch (error) {
				reportAuthError(error);
			}
		});
	addOptions(program.command("connect <harness>")).action(action(installConnector));
	addOptions(connector.command("install <harness>")).action(action(installConnector));
	addOptions(connector.command("rotate <harness>")).action(
		action(async (harness, opts, ctx) => {
			const name = canonicalHarness(harness);
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
	addOptions(program.command("disconnect <harness>"))
		.option("--purge-outbox", "Delete this harness target’s retained session evidence")
		.action(action(disconnect));
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
					const files = await inspectConnectorFiles(connectorFor(harness).getConfigPaths());
					if (files.inlineKeyFiles.length || files.scanIncomplete) inline.push({ harness, ...files });
				}
				for (const [harness, entry] of Object.entries(await new ConnectorRegistry(deps).read())) {
					const outbox = new DurableOutbox(new URL(entry.url).origin, { env: deps.env, harness });
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
				const pendingRevokes = [];
				const deadline = Date.now() + 30000;
				let retried = 0;
				for (const record of await new PendingRevokes(deps).read()) {
					if (retried >= 20 || Date.now() >= deadline) {
						pendingRevokes.push({ ...record, status: "pending" });
						continue;
					}
					retried++;
					await withHarnessLock(record.harness, deps, async () => {
						const active = (await new ConnectorRegistry(deps).read())[record.harness];
						if (active?.url === record.url && active.keyId === record.keyId) {
							pendingRevokes.push({ ...record, status: "active_key" });
							return;
						}
						try {
							await revokeConnectorKey(record, deps);
							await new PendingRevokes(deps).remove(record);
						} catch (error) {
							pendingRevokes.push({
								...record,
								status: "pending",
								reason:
									error instanceof SignetUnauthorizedError
										? error.reason
										: error instanceof Error
											? error.name
											: "revocation_failed",
							});
						}
					});
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
								(key: unknown) => typeof key === "object" && key !== null && "user_id" in key && key.user_id === null,
							).length,
						};
				} catch (error) {
					legacy = { status: error instanceof SignetUnauthorizedError ? "login_required" : "unavailable" };
				}
				if (inline.length || pendingRevokes.length || results.some((result) => !result.healthy) || legacy.unassigned)
					process.exitCode = 1;
				console.log(
					JSON.stringify(
						{ connectors: results, inlineKeys: inline, legacyKeys: legacy, pendingRevokes },
						null,
						opts.json ? undefined : 2,
					),
				);
			} catch (error) {
				reportAuthError(error, opts.json);
			}
		});
}
