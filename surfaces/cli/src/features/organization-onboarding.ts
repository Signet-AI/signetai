import { ConnectorRegistry } from "../../../../libs/sdk/src/node.js";
import type { LoginOnboardingContext } from "../commands/auth.js";
import { reportAuthError } from "../commands/auth.js";
import { connectorFor, installConnector, supportedHarnesses } from "../commands/connector.js";

export interface OrganizationOnboardingUi {
	readonly agentsDir: string;
	readonly interactive: boolean;
	readonly print: (value: string) => void;
	readonly confirm: (question: string) => Promise<boolean>;
}
const visibility =
	"Your personal agent is yours to organize. The organization can read it unless it is hidden by a classification. Classifications limit content to their audience; an administrator is not automatically in that audience. Nothing from your personal workspace is moved or captured by signing in.";
export async function onboardOrganizationHarnesses(context: LoginOnboardingContext, ui: OrganizationOnboardingUi) {
	const identity = await context.transport.get<{ mode: string; agents: { defaultRead: string; defaultWrite: string } }>(
		"/api/auth/whoami",
	);
	if (identity.mode === "local") return { state: "local" };
	const entries = await new ConnectorRegistry(context.options).read();
	const detected = supportedHarnesses.filter((harness) => connectorFor(harness).isDetected());
	const results: { harness: string; state: string; previousTarget: string | null }[] = [];
	if (!context.json) {
		ui.print(visibility);
		ui.print(`Read agent: ${identity.agents.defaultRead}; write agent: ${identity.agents.defaultWrite}.`);
	}
	for (const harness of detected) {
		const previous = entries[harness];
		const previousTarget = previous ? new URL(previous.url).origin : null;
		if (previous && new URL(previous.url).origin === context.target.origin) {
			results.push({ harness, state: "already-connected", previousTarget });
			continue;
		}
		if (context.json || !ui.interactive) {
			results.push({ harness, state: "available", previousTarget });
			if (!context.json)
				ui.print(
					`${harness}${previousTarget ? ` is connected to ${previousTarget}` : " is detected"}. Run signet connect ${harness} --url ${context.target.url} to connect explicitly.`,
				);
			continue;
		}
		if (
			!(await ui.confirm(
				`Connect ${harness} to ${context.target.origin}${previousTarget ? ` instead of ${previousTarget} (personal or another instance)` : ""}?`,
			))
		) {
			results.push({ harness, state: "kept-personal", previousTarget });
			continue;
		}
		try {
			await installConnector(harness, { url: context.target.url }, { ...context.options, agentsDir: ui.agentsDir });
			results.push({ harness, state: "connected", previousTarget });
		} catch (error) {
			reportAuthError(error, context.json);
			results.push({ harness, state: "failed", previousTarget });
		}
	}
	return {
		state: results.some((row) => row.state === "failed") ? "partial" : "complete",
		visibility,
		agents: identity.agents,
		harnesses: results,
	};
}
