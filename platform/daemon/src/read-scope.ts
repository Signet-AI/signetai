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
export { inFlightClassificationSql, localAllReadScope, readScopeSql, requireReadScope } from "@signet/core";
export type { AgentReach, ReadScope } from "@signet/core";
import type { AgentReach, ReadScope } from "@signet/core";
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
