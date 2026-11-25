import type { Principal } from "./principal";
import { audienceSubjectFromPrincipal, resolveReadScope, type ReadScope } from "../read-scope";

export async function principalMessageReadScope(
	principal: Principal | undefined,
	organizationMode: boolean,
): Promise<ReadScope> {
	if (!principal) throw new Error("unauthorized");
	const reach = principal.boundAgentId
		? { kind: "own" as const, agentId: principal.boundAgentId }
		: { kind: "all" as const };
	if (principal.kind === "legacy")
		return {
			reach: organizationMode ? reach : { kind: "all" },
			projects: principal.allowedProjects,
			compartments: organizationMode ? [] : "all",
		};
	return resolveReadScope({ reach, projects: principal.allowedProjects }, audienceSubjectFromPrincipal(principal));
}
