import { z } from "zod";
import type { Principal } from "./auth/principal";
export const readVisibilitySchema = z.object({
	compartments: z.union([z.literal("all"), z.array(z.number().int().positive())]),
	inFlightUserId: z.string().min(1).optional(),
});
export type ReadVisibility = z.infer<typeof readVisibilitySchema>;

export interface AudienceSubject {
	readonly userId: string | null;
	readonly groupIds: readonly string[];
	readonly local: boolean;
}
export function audienceSubjectFromPrincipal(
	principal: Pick<Principal, "kind" | "userId" | "groupIds">,
): AudienceSubject {
	return { userId: principal.userId, groupIds: principal.groupIds, local: principal.kind === "local" };
}
export type AgentReach =
	| { readonly kind: "all" }
	| { readonly kind: "own"; readonly agentId: string }
	| { readonly kind: "shared"; readonly agentId: string }
	| { readonly kind: "group"; readonly agentId: string; readonly group: string };
export interface ReadScope {
	readonly reach: AgentReach;
	readonly inFlightUserId?: string;
	readonly compartments: "all" | readonly number[];
	readonly projects: readonly string[] | null;
}
function identifier(value: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Invalid SQL identifier");
	return value;
}
function jobValue(alias: string, key: string): string {
	return `json_extract(CASE WHEN json_valid(${alias}.params_json) THEN ${alias}.params_json ELSE '{}' END,'$.${key}')`;
}
export function inFlightClassificationSql(alias: string): string {
	const j = identifier(alias),
		classification = jobValue(j, "id");
	return `${j}.kind='classify' AND ${j}.status IN ('pending','running','failed') AND (${j}.status!='failed' OR EXISTS(SELECT 1 FROM classification_assignments a WHERE a.agent_id=${jobValue(j, "target.agentId")} AND a.target_kind=${jobValue(j, "target.kind")} AND a.target_id=${jobValue(j, "target.id")} AND a.classification_id=${classification})) AND NOT EXISTS(SELECT 1 FROM classification_audience audience WHERE audience.classification_id=${classification} AND ((audience.principal_kind='user' AND audience.principal_id=?) OR (audience.principal_kind='group' AND audience.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))))`;
}
export function readScopeSql(
	alias: string,
	scope: ReadScope,
	cols?: {
		agent?: string;
		compartment?: string;
		project?: string;
		visibility?: string | null;
		checkpoint?: boolean;
		current?: boolean;
		memory?: string | null;
		session?: string | null;
		source?: string | null;
	},
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
	if (reach.kind === "all") {
		const active = `${agent} IN (SELECT id FROM agents WHERE archived_at IS NULL)`;
		clauses.push(
			cols?.checkpoint
				? `(${active} OR (${agent} IS NULL AND EXISTS(SELECT 1 FROM session_transcripts t WHERE t.session_key=${col("session_key")}) AND NOT EXISTS(SELECT 1 FROM (SELECT agent_id FROM session_transcripts WHERE session_key=${col("session_key")} UNION SELECT agent_id FROM session_claims WHERE session_key=${col("session_key")}) owners LEFT JOIN agents a ON a.id=owners.agent_id WHERE a.id IS NULL OR a.archived_at IS NOT NULL)))`
				: active,
		);
	} else if (!visibility && (reach.kind === "shared" || reach.kind === "group")) {
		clauses.push(`${agent} = ?`);
		args.push(reach.agentId);
	} else if (reach.kind === "shared") {
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
	if (scope.inFlightUserId) {
		const j = alias === "_signet_classification_job" ? "__signet_classification_job" : "_signet_classification_job";
		const target = jobValue(j, "target.id"),
			kind = jobValue(j, "target.kind"),
			jobAgent = jobValue(j, "target.agentId");
		const own = (column: string | null) => (column === null ? "NULL" : col(column));
		const memory = own(cols?.memory === undefined ? (cols?.checkpoint ? null : "id") : cols.memory);
		const session = own(cols?.session === undefined ? (cols?.checkpoint ? "session_key" : "source_id") : cols.session);
		const source = own(cols?.source === undefined ? (cols?.checkpoint ? null : "source_id") : cols.source);
		const matchesAgent = cols?.checkpoint
			? `(${jobAgent}=${agent} OR (${agent} IS NULL AND ${jobAgent} IN (SELECT agent_id FROM session_transcripts WHERE session_key=${col("session_key")} UNION SELECT agent_id FROM session_claims WHERE session_key=${col("session_key")})))`
			: `${jobAgent}=${agent}`;
		clauses.push(
			`NOT EXISTS(SELECT 1 FROM org_jobs ${j} WHERE ${inFlightClassificationSql(j)} AND ${matchesAgent} AND (${kind}='agent' OR (${kind}='memory' AND ${target}=${memory}) OR (${kind}='session' AND (${target}=${session} OR 'session:'||${target}=${session} OR ${target}='session:'||${session})) OR (${kind}='source' AND (${target}=${source} OR substr(${source},1,length(${target})+1)=${target}||':'))))`,
		);
		args.push(scope.inFlightUserId, scope.inFlightUserId);
	}
	if (cols?.current) {
		const target = readScopeSql("_readable_superseder", scope);
		clauses.push(
			`(${col("superseded_by")} IS NULL OR NOT EXISTS(SELECT 1 FROM memories _readable_superseder WHERE _readable_superseder.id=${col("superseded_by")}${target.sql}))`,
		);
		args.push(...target.args);
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
	resolveVisibility: (subject: AudienceSubject) => Promise<ReadVisibility> = async (subject) => {
		if (subject.local) return { compartments: "all" };
		const { classificationRequest } = await import("./classifications");
		return readVisibilitySchema.parse(await classificationRequest({ op: "visibility", subject }));
	},
): Promise<ReadScope> {
	if (!subject.local && !subject.userId) throw new Error("unauthorized");
	return { reach: input.reach, projects: input.projects, ...(await resolveVisibility(subject)) };
}
