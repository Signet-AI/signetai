import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { editYamlConfigFile, parseRuntimeYaml } from "@signet/core";
import {
	TELEMETRY_CONSENT_BODY,
	TELEMETRY_CONSENT_PATH,
	TELEMETRY_CONSENT_TITLE,
	readTelemetryConsent,
} from "@signet/core/telemetry-consent";

export function readWorkspaceTelemetryConsent(basePath: string): boolean | undefined {
	return readTelemetryConsent(parseRuntimeYaml(readFileSync(join(basePath, "agent.yaml"), "utf8")));
}

export function writeTelemetryConsent(basePath: string, enabled: boolean): void {
	editYamlConfigFile(join(basePath, "agent.yaml"), (editor) => editor.set(TELEMETRY_CONSENT_PATH, enabled));
}

export function telemetryConsentDisabledByEnv(): boolean {
	return process.env.SIGNET_TELEMETRY_OPTOUT === "1" || process.env.SIGNET_TELEMETRY_OPTOUT === "true";
}

export async function promptTelemetryConsent(basePath: string): Promise<void> {
	if (!process.stdin.isTTY || telemetryConsentDisabledByEnv() || readWorkspaceTelemetryConsent(basePath) !== undefined)
		return;
	console.log(`\n  ${chalk.bold(TELEMETRY_CONSENT_TITLE)}\n`);
	for (const paragraph of TELEMETRY_CONSENT_BODY)
		console.log(`  ${paragraph.replace(/`([^`]+)`/g, (_, code: string) => chalk.cyan(code))}\n`);
	const enabled = await confirm({ message: "Send anonymous usage data?", default: false });
	writeTelemetryConsent(basePath, enabled);
	console.log(enabled ? chalk.green("  ✓ Usage data on. Thanks.") : chalk.dim("  Usage data off."));
}
