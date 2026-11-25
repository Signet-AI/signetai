import { rm } from "node:fs/promises";
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
	NodeTransport,
	resolveTarget,
	writeKeyFile,
	readKeyFile,
} from "../../../../libs/sdk/src/node.js";
import { SignetUnauthorizedError } from "../../../../libs/sdk/src/index.js";
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
	readonly configureHarnessHooks: (harness: string, basePath: string) => Promise<void>;
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
	credential?: { kind?: string; deviceId?: string };
}
interface IssuedKey {
	key: { id: string; agentId?: string; deviceId?: string; expiresAt: string };
	secret: string;
}
async function installConnector(raw: string, options: ConnectorInstallOptions, deps: ConnectorDeps): Promise<void> {
	const harness = canonical(raw);
	const installer = connectorFor(harness, options.profile);
	const target = await resolveTarget({ ...deps, flagUrl: options.url ?? deps.flagUrl });
	const transport = new NodeTransport(target, { env: deps.env });
	const identity = await transport.get<Identity>("/api/auth/whoami");
	const registry = new ConnectorRegistry(deps);
	const previous = (await registry.read())[harness];
	let issued: IssuedKey | undefined;
	if (target.remote || identity.mode === "team") {
		if (identity.credential?.kind !== "session" || !identity.credential.deviceId)
			throw new SignetUnauthorizedError("missing_credential");
		issued = await transport.post<IssuedKey>("/api/auth/connector-keys", {
			harness,
			deviceId: identity.credential.deviceId,
			...((options.agent ?? options.agentId) ? { agentId: options.agent ?? options.agentId } : {}),
		});
	}
	const keyFile = issued ? await writeKeyFile(target.origin, harness, issued.secret, deps) : undefined;
	const agentId = issued?.key.agentId ?? options.agent ?? options.agentId;
	await registry.set(harness, {
		url: target.url,
		...(keyFile ? { keyFile } : {}),
		...(agentId ? { agentId } : {}),
		...(issued ? { keyId: issued.key.id, deviceId: issued.key.deviceId ?? identity.credential?.deviceId } : {}),
	});
	const result = await installer.install(options.path ?? deps.agentsDir);
	if (!result.success) throw new Error(result.message);
	if (previous?.keyId) {
		const oldTarget = await resolveTarget({ ...deps, flagUrl: previous.url });
		await new NodeTransport(oldTarget, { env: deps.env }).request(
			"DELETE",
			`/api/auth/connector-keys/${encodeURIComponent(previous.keyId)}`,
		);
	}
	if (previous?.keyFile && previous.keyFile !== keyFile) await rm(previous.keyFile);
	await new NodeTransport(await resolveTarget({ ...deps, harness }), { env: deps.env }).flush();
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
	const entry = (await registry.read())[harness];
	if (entry?.keyId) {
		const target = await resolveTarget({ ...deps, flagUrl: entry.url });
		await new NodeTransport(target, { env: deps.env }).request(
			"DELETE",
			`/api/auth/connector-keys/${encodeURIComponent(entry.keyId)}`,
		);
	}
	await connectorFor(harness, options.profile).uninstall();
	if (entry?.keyFile) await rm(entry.keyFile);
	await registry.remove(harness);
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
	addOptions(program.command("connect <harness>")).action(action(installConnector));
	addOptions(connector.command("install <harness>")).action(action(installConnector));
	addOptions(connector.command("rotate <harness>")).action(
		action(async (harness, opts, ctx) => {
			const entry = (await new ConnectorRegistry(ctx).read())[canonical(harness)];
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
				console.log(JSON.stringify(await new ConnectorRegistry(deps).read(), null, opts.json ? undefined : 2));
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
				for (const [harness, entry] of Object.entries(await new ConnectorRegistry(deps).read())) {
					try {
						if (entry.keyFile) await readKeyFile(entry.keyFile);
						const transport = new NodeTransport(await resolveTarget({ ...deps, harness }), { env: deps.env });
						const identity = await transport.get<Identity>("/api/auth/whoami");
						await transport.flush();
						results.push({
							harness,
							url: entry.url,
							healthy: true,
							mode: identity.mode,
							outbox: await transport.outbox.status(),
						});
					} catch (error) {
						results.push({
							harness,
							healthy: false,
							error: error instanceof Error ? error.message : "Inspection failed",
						});
					}
				}
				console.log(JSON.stringify(results, null, opts.json ? undefined : 2));
			} catch (error) {
				reportAuthError(error, opts.json);
			}
		});
}
