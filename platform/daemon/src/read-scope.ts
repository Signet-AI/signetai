export interface AudienceSubject {
	readonly userId: string | null;
	readonly groupIds: readonly string[];
	readonly local: boolean;
}
export type AgentReach =
	| { readonly kind: "all" }
	| { readonly kind: "own"; readonly agentId: string }
	| { readonly kind: "shared"; readonly agentId: string }
	| { readonly kind: "group"; readonly agentId: string; readonly group: string };
export interface ReadScope {
	readonly reach: AgentReach;
	readonly compartments: "all" | readonly number[];
	readonly projects: readonly string[] | null;
}
function identifier(value: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Invalid SQL identifier");
	return value;
}
export function readScopeSql(
	alias: string,
	scope: ReadScope,
	cols?: { agent?: string; compartment?: string; project?: string; visibility?: string | null },
): { sql: string; args: unknown[] } {
	const prefix = alias ? `${identifier(alias)}.` : "";
	const col = (name: string) => `${prefix}${identifier(name)}`;
	const agent = col(cols?.agent ?? "agent_id");
	const compartment = col(cols?.compartment ?? "compartment_id");
	const project = col(cols?.project ?? "project");
	const visibility = cols?.visibility === null ? null : col(cols?.visibility ?? "visibility");
	const args: unknown[] = [];
	const clauses: string[] = [];
	const reach = scope.reach;
	if (reach.kind === "all") clauses.push(`${agent} IN (SELECT id FROM agents WHERE archived_at IS NULL)`);
	else if (reach.kind === "shared") {
		if (!visibility) throw new Error("shared reach requires visibility");
		clauses.push(`(${visibility} = 'global' OR ${agent} = ?)`);
		args.push(reach.agentId);
	} else if (reach.kind === "group") {
		clauses.push(
			visibility
				? `((${visibility} = 'global' AND ${agent} IN (SELECT id FROM agents WHERE policy_group = ?)) OR ${agent} = ?)`
				: `(${agent} IN (SELECT id FROM agents WHERE policy_group = ?) OR ${agent} = ?)`,
		);
		args.push(reach.group, reach.agentId);
	} else {
		clauses.push(`${agent} = ?`);
		args.push(reach.agentId);
	}
	if (visibility) clauses.push(`${visibility} != 'archived'`);
	if (scope.compartments !== "all") {
		for (const c of scope.compartments) if (!Number.isSafeInteger(c) || c < 1) throw new Error("Invalid compartment");
		clauses.push(
			scope.compartments.length
				? `(${compartment} IS NULL OR ${compartment} IN (${scope.compartments.map(() => "?").join(",")}))`
				: `${compartment} IS NULL`,
		);
		args.push(...scope.compartments);
	}
	if (scope.projects !== null) {
		clauses.push(scope.projects.length ? `${project} IN (${scope.projects.map(() => "?").join(",")})` : "0");
		args.push(...scope.projects);
	}
	return { sql: clauses.map((c) => ` AND ${c}`).join(""), args };
}
export async function readableCompartments(subject: AudienceSubject): Promise<"all" | readonly number[]> {
	if (subject.local) return "all";
	const { classificationRequest } = await import("./classifications");
	return classificationRequest<readonly number[]>({ op: "readable", subject });
}
export async function resolveReadScope(
	input: { readonly reach: AgentReach; readonly projects: readonly string[] | null },
	subject: AudienceSubject,
	resolveCompartments: (subject: AudienceSubject) => Promise<"all" | readonly number[]> = readableCompartments,
): Promise<ReadScope> {
	if (!subject.local && !subject.userId) throw new Error("unauthorized");
	return { reach: input.reach, projects: input.projects, compartments: await resolveCompartments(subject) };
}
