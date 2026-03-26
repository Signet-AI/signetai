import { checkScope } from "./auth";
import type { AuthMode, TokenClaims } from "./auth";

function normalize(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text && text.length > 0 ? text : undefined;
}

export function shouldEnforceScope(authMode: AuthMode, claims: TokenClaims | null): boolean {
	if (authMode === "local") return false;
	if (authMode === "hybrid" && !claims) return false;
	return true;
}

export function resolveScopedAgent(
	claims: TokenClaims | null,
	authMode: AuthMode,
	requestedAgentId: string | undefined,
	fallbackAgentId = "default",
): { agentId: string; error?: string } {
	const scopedAgentId = normalize(claims?.scope.agent);
	const requested = normalize(requestedAgentId);
	const agentId = requested ?? scopedAgentId ?? fallbackAgentId;

	if (!shouldEnforceScope(authMode, claims)) {
		return { agentId };
	}

	const decision = checkScope(claims, { agent: agentId }, authMode);
	if (!decision.allowed) {
		return { agentId, error: decision.reason ?? "scope violation" };
	}

	return { agentId };
}

export function resolveScopedProject(
	claims: TokenClaims | null,
	authMode: AuthMode,
	requestedProject: string | undefined,
): { project: string | undefined; error?: string } {
	const scopedProject = normalize(claims?.scope.project);
	const project = normalize(requestedProject) ?? scopedProject;

	if (!shouldEnforceScope(authMode, claims) || !project) {
		return { project };
	}

	const decision = checkScope(claims, { project }, authMode);
	if (!decision.allowed) {
		return { project, error: decision.reason ?? "scope violation" };
	}

	return { project };
}
