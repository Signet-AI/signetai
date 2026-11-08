import type { Command } from "commander";
import {
	readWorkspaceTelemetryConsent,
	telemetryConsentDisabledByEnv,
	writeTelemetryConsent,
} from "../features/telemetry-consent.js";
import { withPath } from "./shared.js";

export function registerTelemetryCommands(
	program: Command,
	deps: {
		readonly AGENTS_DIR: string;
		readonly normalizeAgentPath: (path: string) => string;
	},
): void {
	withPath(
		program.command("telemetry [state]").description("Show or change anonymous usage data consent (on or off)"),
	).action((state: string | undefined, options: { path?: string }) => {
		const basePath = deps.normalizeAgentPath(options.path ?? deps.AGENTS_DIR);
		if (state !== undefined) {
			if (state !== "on" && state !== "off") throw new Error("Usage: signet telemetry [on|off]");
			writeTelemetryConsent(basePath, state === "on");
			console.log(state === "on" ? "Usage data on. Thanks." : "Usage data off.");
			if (telemetryConsentDisabledByEnv()) console.log("Usage data disabled by SIGNET_TELEMETRY_OPTOUT.");
			return;
		}
		if (telemetryConsentDisabledByEnv()) {
			console.log("Usage data disabled by SIGNET_TELEMETRY_OPTOUT.");
			return;
		}
		const consent = readWorkspaceTelemetryConsent(basePath);
		console.log(
			consent === true
				? "Usage data on."
				: consent === false
					? "Usage data off."
					: "Usage data not yet answered (off).",
		);
	});
}
