import { z } from "zod";
import { classificationRequest } from "./classifications";
import { audienceSubjectFromPrincipal } from "./read-scope";

const definitions = z.array(z.object({ id: z.string(), name: z.string() }));
export async function readableClassificationsFor(
	userId: string,
): Promise<readonly { id: string; name: string; why: string }[]> {
	const result = await classificationRequest({
		op: "list",
		actor: {
			...audienceSubjectFromPrincipal({ kind: "user", userId, groupIds: [] }),
			compliance: false,
			boundAgentId: null,
			allowedProjects: null,
			credential: "system:access-inspection",
		},
	});
	return definitions
		.parse(result)
		.map(({ id, name }) => ({ id, name, why: "Audience member directly or through a group" }));
}
