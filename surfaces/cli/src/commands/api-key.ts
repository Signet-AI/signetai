import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonApiCall } from "../lib/daemon.js";
import { withJson } from "./shared.js";

interface ApiKeyDeps {
	readonly ensureDaemonRunning: () => Promise<boolean>;
	readonly apiCall: DaemonApiCall;
}

interface ApiKeyCreateOptions {
	name?: string;
	connector?: string;
	role?: string;
	agentId?: string;
	expiresAt?: string;
	json?: boolean;
}

interface ApiKeyListOptions {
	json?: boolean;
}

interface ApiKeyRevokeOptions {
	json?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(data: unknown): string {
	if (isRecord(data) && typeof data.error === "string") return data.error;
	return "Request failed";
}

function formatNullable(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : chalk.dim("-");
}

export function registerApiKeyCommands(program: Command, deps: ApiKeyDeps): void {
	const apiKey = program.command("api-key").description("Manage daemon API keys for remote connectors");

	const create = apiKey
		.command("create")
		.description("Create a named API key")
		.requiredOption("--name <name>", "Human-readable key name")
		.option("--connector <connector>", "Connector/harness this key is for, e.g. pi, codex, opencode")
		.option("--role <role>", "Role for this key (admin, operator, agent, readonly)", "agent")
		.option("--agent-id <id>", "Optional Signet agent scope")
		.option("--expires-at <iso>", "Optional ISO expiration timestamp")
		.action(async (options: ApiKeyCreateOptions) => {
			if (!(await deps.ensureDaemonRunning())) process.exit(1);
			const payload = {
				name: options.name,
				connector: options.connector,
				harness: options.connector,
				role: options.role,
				agentId: options.agentId,
				scope: options.agentId ? { agent: options.agentId } : {},
				expiresAt: options.expiresAt,
			};
			const res = await deps.apiCall("POST", "/api/auth/api-keys", payload);
			if (!res.ok) {
				console.error(chalk.red(`Error: ${readError(res.data)}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(res.data, null, 2));
				return;
			}
			const apiKeyData = isRecord(res.data) && isRecord(res.data.apiKey) ? res.data.apiKey : null;
			if (!apiKeyData) {
				console.log(JSON.stringify(res.data, null, 2));
				return;
			}
			console.log(chalk.green("API key created:"));
			console.log(`  ${chalk.dim("name:")}      ${apiKeyData.name}`);
			console.log(`  ${chalk.dim("id:")}        ${apiKeyData.id}`);
			console.log(`  ${chalk.dim("prefix:")}    ${apiKeyData.prefix}`);
			console.log(`  ${chalk.dim("key:")}       ${apiKeyData.key}`);
			console.log(`  ${chalk.dim("role:")}      ${apiKeyData.role}`);
			console.log(`  ${chalk.dim("connector:")} ${formatNullable(apiKeyData.connector)}`);
			console.log();
			console.log(chalk.yellow("Save this key now. It will not be shown again."));
		});
	withJson(create);

	const list = apiKey
		.command("list")
		.description("List API keys without revealing secrets")
		.action(async (options: ApiKeyListOptions) => {
			if (!(await deps.ensureDaemonRunning())) process.exit(1);
			const res = await deps.apiCall("GET", "/api/auth/api-keys");
			if (!res.ok) {
				console.error(chalk.red(`Error: ${readError(res.data)}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(res.data, null, 2));
				return;
			}
			const keys = isRecord(res.data) && Array.isArray(res.data.apiKeys) ? res.data.apiKeys : [];
			if (keys.length === 0) {
				console.log(chalk.dim("No API keys."));
				return;
			}
			for (const item of keys) {
				if (!isRecord(item)) continue;
				const status = item.revokedAt ? chalk.red("revoked") : item.expiresAt ? chalk.yellow("expires") : chalk.green("active");
				console.log(`${item.id}  ${item.prefix}  ${status}  ${item.name}`);
				console.log(`  role=${item.role} connector=${formatNullable(item.connector)} lastUsed=${formatNullable(item.lastUsedAt)}`);
			}
		});
	withJson(list);

	const revoke = apiKey
		.command("revoke <id-or-prefix>")
		.description("Revoke an API key by id or prefix")
		.action(async (idOrPrefix: string, options: ApiKeyRevokeOptions) => {
			if (!(await deps.ensureDaemonRunning())) process.exit(1);
			const res = await deps.apiCall("DELETE", `/api/auth/api-keys/${encodeURIComponent(idOrPrefix)}`);
			if (!res.ok) {
				console.error(chalk.red(`Error: ${readError(res.data)}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(res.data, null, 2));
				return;
			}
			const revoked = isRecord(res.data) && isRecord(res.data.apiKey) ? res.data.apiKey : null;
			console.log(chalk.green(`Revoked API key ${revoked?.id ?? idOrPrefix}`));
		});
	withJson(revoke);
}
