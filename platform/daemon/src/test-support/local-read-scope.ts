import type { AgentRosterReadPolicy } from "@signet/core";
import { localAgentReach } from "../memory-search-filters";
import { type ReadScope, localAllReadScope } from "../read-scope";

export interface LocalScopeHint {
	readonly agentId?: string;
	readonly readPolicy?: AgentRosterReadPolicy;
	readonly policyGroup?: string | null;
	readonly readScope?: ReadScope;
}

export function localTestReadScope(
	agentId: string,
	readPolicy?: AgentRosterReadPolicy,
	policyGroup?: string | null,
): ReadScope {
	return localAllReadScope(localAgentReach(agentId, readPolicy, policyGroup));
}

export function withLocalReadScope<T extends LocalScopeHint>(params: T): T & { readonly readScope: ReadScope } {
	return {
		...params,
		readScope:
			params.readScope ?? localTestReadScope(params.agentId ?? "default", params.readPolicy, params.policyGroup),
	};
}
