#!/usr/bin/env node

/**
 * signet-llama-chat
 *
 * Interactive chat CLI that bridges llama-server with Signet's memory
 * and tool system. Uses llama-server's OpenAI-compatible API for
 * inference and Signet's daemon for persistent tools.
 *
 * Usage:
 *   signet-llama-chat
 *   signet-llama-chat --server http://localhost:8080
 *   signet-llama-chat --model Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf
 *   signet-llama-chat --daemon http://localhost:3850
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runChat } from "./chat.js";

interface CliArgs {
	llamaServerUrl: string;
	daemonUrl: string;
	model?: string;
	contextLength: number;
	systemPrompt: string;
	maxRounds: number;
}

function parseArgs(raw: string[]): CliArgs {
	const args: Record<string, string> = {};
	for (let i = 0; i < raw.length; i++) {
		if (raw[i]?.startsWith("--")) {
			const key = raw[i]?.slice(2);
			args[key] = raw[i + 1] ?? "";
			i++;
		}
	}

	const configDir = join(homedir(), ".config", "signet-llama-cpp");
	const configPath = join(configDir, "config.json");

	let fileConfig: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		} catch {
			// Ignore
		}
	}

	const daemonUrl =
		args.daemon ?? env("SIGNET_DAEMON_URL") ?? (fileConfig.signetDaemonUrl as string) ?? "http://localhost:3850";

	const llamaServerUrl =
		args.server ?? env("LLAMA_CPP_SERVER_URL") ?? (fileConfig.llamaServerUrl as string) ?? "http://localhost:8080";

	const model = args.model ?? (fileConfig.model as string | undefined);
	const contextLength = Number(args["context-length"] ?? fileConfig.contextLength ?? 8192);
	const maxRounds = Number(args["max-rounds"] ?? 10);

	let systemPrompt = args["system-prompt"] ?? (fileConfig.systemPrompt as string) ?? "";
	if (!systemPrompt) {
		systemPrompt = "You are a helpful AI assistant with access to persistent memory tools through Signet.";
	}

	return { llamaServerUrl, daemonUrl, model, contextLength, systemPrompt, maxRounds };
}

function env(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const cliArgs = parseArgs(process.argv.slice(2));

runChat({
	llamaServerUrl: cliArgs.llamaServerUrl,
	daemonUrl: cliArgs.daemonUrl,
	systemPrompt: cliArgs.systemPrompt,
	model: cliArgs.model,
	contextLength: cliArgs.contextLength,
	maxRounds: cliArgs.maxRounds,
}).catch((err) => {
	console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
