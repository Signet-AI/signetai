import { SIGNET_SECRETS_PLUGIN_ID } from "@signet/core";
import type { PluginManifestV1, PluginSurfaceDeclarationsV1 } from "../types.js";

const SECRET_CAPABILITIES = [
	"secrets:list",
	"secrets:write",
	"secrets:delete",
	"secrets:exec",
	"secrets:providers:list",
	"secrets:providers:configure",
	"prompt:contribute:user-prompt-submit",
	"mcp:tool",
	"cli:command",
	"dashboard:panel",
	"sdk:client",
	"connector:capability",
] as const;

const surfaces: PluginSurfaceDeclarationsV1 = {
	daemonRoutes: [
		{
			method: "GET",
			path: "/api/secrets",
			summary: "List stored local secret names",
			requiredCapabilities: ["secrets:list"],
		},
		{
			method: "POST",
			path: "/api/secrets/:name",
			summary: "Store a local secret",
			requiredCapabilities: ["secrets:write"],
		},
		{
			method: "DELETE",
			path: "/api/secrets/:name",
			summary: "Delete a local secret",
			requiredCapabilities: ["secrets:delete"],
		},
		{
			method: "POST",
			path: "/api/secrets/exec",
			summary: "Run a command with injected secrets",
			requiredCapabilities: ["secrets:exec"],
		},
		{
			method: "POST",
			path: "/api/secrets/:name/exec",
			summary: "Legacy single-secret exec route",
			requiredCapabilities: ["secrets:exec"],
		},
		{
			method: "GET",
			path: "/api/secrets/1password/status",
			summary: "Inspect 1Password compatibility provider status",
			requiredCapabilities: ["secrets:providers:list"],
		},
		{
			method: "POST",
			path: "/api/secrets/1password/connect",
			summary: "Configure 1Password compatibility provider",
			requiredCapabilities: ["secrets:providers:configure"],
		},
		{
			method: "DELETE",
			path: "/api/secrets/1password/connect",
			summary: "Disconnect 1Password compatibility provider",
			requiredCapabilities: ["secrets:providers:configure"],
		},
		{
			method: "GET",
			path: "/api/secrets/1password/vaults",
			summary: "List 1Password vaults",
			requiredCapabilities: ["secrets:providers:list"],
		},
		{
			method: "POST",
			path: "/api/secrets/1password/import",
			summary: "Import 1Password items into local Signet secrets",
			requiredCapabilities: ["secrets:providers:configure"],
		},
	],
	cliCommands: [
		{ path: ["secret", "list"], summary: "List secret names", requiredCapabilities: ["cli:command", "secrets:list"] },
		{ path: ["secret", "put"], summary: "Store a secret", requiredCapabilities: ["cli:command", "secrets:write"] },
		{ path: ["secret", "delete"], summary: "Delete a secret", requiredCapabilities: ["cli:command", "secrets:delete"] },
		{
			path: ["secret", "exec"],
			summary: "Run a command with injected secrets",
			requiredCapabilities: ["cli:command", "secrets:exec"],
		},
		{
			path: ["secret", "onepassword"],
			summary: "Manage 1Password compatibility integration",
			requiredCapabilities: ["cli:command", "secrets:providers:configure"],
		},
	],
	mcpTools: [
		{
			name: "secret_list",
			title: "List Secrets",
			summary: "List available secret names without values",
			requiredCapabilities: ["mcp:tool", "secrets:list"],
		},
		{
			name: "secret_exec",
			title: "Execute with Secrets",
			summary: "Run a command with secret values injected and redacted",
			requiredCapabilities: ["mcp:tool", "secrets:exec"],
		},
	],
	dashboardPanels: [
		{
			id: "settings.secrets",
			title: "Secrets",
			summary: "Manage local encrypted Signet secrets and 1Password compatibility",
			requiredCapabilities: ["dashboard:panel", "secrets:list"],
		},
	],
	sdkClients: [
		{ name: "listSecrets", summary: "List stored secret names", requiredCapabilities: ["sdk:client", "secrets:list"] },
		{ name: "storeSecret", summary: "Store a secret", requiredCapabilities: ["sdk:client", "secrets:write"] },
		{ name: "deleteSecret", summary: "Delete a secret", requiredCapabilities: ["sdk:client", "secrets:delete"] },
		{
			name: "execWithSecrets",
			summary: "Run a command with injected secrets",
			requiredCapabilities: ["sdk:client", "secrets:exec"],
		},
		{
			name: "getOnePasswordStatus",
			summary: "Inspect 1Password compatibility status",
			requiredCapabilities: ["sdk:client", "secrets:providers:list"],
		},
		{
			name: "connectOnePassword",
			summary: "Configure 1Password compatibility",
			requiredCapabilities: ["sdk:client", "secrets:providers:configure"],
		},
	],
	connectorCapabilities: [
		{
			id: "secrets.list",
			title: "Secret Listing",
			summary: "Connector may advertise secret name listing",
			requiredCapabilities: ["connector:capability", "secrets:list"],
		},
		{
			id: "secrets.exec",
			title: "Secret Execution",
			summary: "Connector may advertise secret command execution",
			requiredCapabilities: ["connector:capability", "secrets:exec"],
		},
	],
	promptContributions: [
		{
			id: "signet.secrets.credential-guidance",
			target: "user-prompt-submit",
			mode: "context",
			priority: 420,
			maxTokens: 80,
			summary: "Advise agents to keep reusable credentials in Signet Secrets",
			requiredCapabilities: ["prompt:contribute:user-prompt-submit"],
		},
	],
};

export { SIGNET_SECRETS_PLUGIN_ID };

export const signetSecretsManifest: PluginManifestV1 = {
	id: SIGNET_SECRETS_PLUGIN_ID,
	name: "Signet Secrets",
	version: "1.0.0",
	publisher: "signetai",
	description: "Privileged core plugin for encrypted local secrets, compatibility providers, and secret injection.",
	runtime: {
		language: "typescript",
		kind: "bundled-module",
		entry: "@signet/daemon/plugins/bundled/secrets",
	},
	compatibility: {
		signet: ">=0.99.0 <1.0.0",
		pluginApi: "1.x",
	},
	trustTier: "core",
	capabilities: SECRET_CAPABILITIES,
	surfaces,
	marketplace: {
		categories: ["secrets", "security"],
		license: "Apache-2.0",
		repository: "https://github.com/signetai/signetai",
		homepage: "https://signetai.sh",
		checksum: null,
		signature: null,
	},
	docs: {
		homepage: "https://signetai.sh/docs/secrets",
		capabilities: {
			"secrets:list": { summary: "List secret names without values" },
			"secrets:write": { summary: "Store or update local encrypted secrets" },
			"secrets:delete": { summary: "Delete local encrypted secrets" },
			"secrets:exec": { summary: "Resolve secrets only for daemon-owned command injection" },
			"secrets:providers:list": { summary: "List configured compatibility secret providers" },
			"secrets:providers:configure": { summary: "Configure compatibility secret providers" },
			"prompt:contribute:user-prompt-submit": { summary: "Contribute bounded secret-safety guidance to prompt submit" },
			"mcp:tool": { summary: "Expose value-safe secret MCP tools" },
			"cli:command": { summary: "Expose Signet secret CLI commands" },
			"dashboard:panel": { summary: "Expose Secrets settings panel metadata" },
			"sdk:client": { summary: "Expose typed SDK helpers for value-safe secret operations" },
			"connector:capability": { summary: "Advertise connector-visible secret capabilities" },
		},
	},
	promptContributions: [
		{
			id: "signet.secrets.credential-guidance",
			pluginId: SIGNET_SECRETS_PLUGIN_ID,
			target: "user-prompt-submit",
			mode: "context",
			priority: 420,
			maxTokens: 80,
			content:
				"When the user provides credentials or a task requires reusable credentials, prefer storing them in Signet Secrets rather than chat, memory, logs, or source files. Use secret_exec or provider-backed secret references when commands need credentials.",
		},
	],
};
