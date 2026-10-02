import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonApiCall } from "../lib/daemon";
import { withJson } from "./shared.js";

export interface DaemonCommandDeps {
	readonly ensureDaemonForSecrets: () => Promise<boolean>;
	readonly secretApiCall: DaemonApiCall;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function addCommonOptions(cmd: Command): Command {
	return withJson(cmd.option("--agent <name>", "Agent scope, default default"));
}

export function appendAgent(params: URLSearchParams, agent?: string): void {
	if (agent) params.set("agent_id", agent);
}

export interface CommandApiRequest {
	readonly method: string;
	readonly path: string;
	readonly fallback: string;
	readonly body?: unknown;
	readonly timeoutMs?: number;
}

export async function commandApiCall(secretApiCall: DaemonApiCall, request: CommandApiRequest): Promise<unknown> {
	const { ok, data } = await secretApiCall(request.method, request.path, request.body, request.timeoutMs);
	const error = asRecord(data).error;
	if (!ok || typeof error === "string") {
		console.error(chalk.red(typeof error === "string" ? error : request.fallback));
		process.exit(1);
	}
	return data;
}

export function getCommandData(
	secretApiCall: DaemonApiCall,
	path: string,
	params: URLSearchParams,
	fallback: string,
): Promise<unknown> {
	const query = params.toString();
	return commandApiCall(secretApiCall, {
		method: "GET",
		path: query ? `${path}?${query}` : path,
		fallback,
		timeoutMs: 10_000,
	});
}
