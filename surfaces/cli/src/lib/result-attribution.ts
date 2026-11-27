import { z } from "zod";
import { renderResultAttribution, type ResultAttribution } from "@signet/core";
export { renderResultAttribution };
const named = z.object({ id: z.string(), name: z.string(), handle: z.string().optional() });
const response = z.object({
	authors: z.array(named).max(400),
	agents: z.array(named).max(400),
	memories: z
		.array(
			z.object({
				id: z.string(),
				authorUserId: z.string().nullable(),
				agentId: z.string(),
				sourcePath: z.string().optional(),
				authorKind: z.literal("system").optional(),
			}),
		)
		.max(300),
	organizationMode: z.boolean().optional(),
});
export function resultField(row: object, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value: unknown = Reflect.get(row, key);
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}
function identity(row: object): object {
	const nested: unknown = Reflect.get(row, "writeIdentity");
	return typeof nested === "object" && nested !== null ? nested : row;
}
export async function attributeResults<T extends object>(
	rows: readonly T[],
	request: (body: unknown) => Promise<unknown>,
	memory = false,
): Promise<(T & { attribution?: ResultAttribution })[]> {
	const result: (T & { attribution?: ResultAttribution })[] = [];
	for (let offset = 0; offset < rows.length; offset += 100) {
		const batch = rows.slice(offset, offset + 100),
			authorId = (row: object) =>
				resultField(
					identity(row),
					"authorUserId",
					"author_user_id",
					"speakerUserId",
					"speaker_user_id",
					"actor_user_id",
					"user_id",
				),
			agentId = (row: object) => resultField(identity(row), "agentId", "agent_id");
		const authors = [...new Set(batch.flatMap((row) => (authorId(row) ? [authorId(row)] : [])))].filter(
			(id): id is string => typeof id === "string",
		);
		const agents = [...new Set(batch.flatMap((row) => (agentId(row) ? [agentId(row)] : [])))].filter(
			(id): id is string => typeof id === "string",
		);
		const memories = memory
			? batch
					.flatMap((row) => (resultField(row, "id") ? [resultField(row, "id")] : []))
					.filter((id): id is string => typeof id === "string")
			: [];
		const labels =
			authors.length || agents.length || memories.length
				? response.parse(
						await request({
							authors,
							agents,
							memories,
							artifactPaths: memory
								? batch
										.flatMap((row) => (resultField(row, "source_path") ? [resultField(row, "source_path")] : []))
										.filter((id): id is string => typeof id === "string")
								: [],
						}),
					)
				: { authors: [], agents: [], memories: [] };
		for (const row of batch) {
			const canonical = labels.memories.find(
					(item) =>
						item.id === resultField(row, "id") ||
						(!!item.sourcePath && item.sourcePath === resultField(row, "source_path")),
				),
				author = canonical?.authorUserId ?? authorId(row),
				agent = canonical?.agentId ?? agentId(row);
			const person = labels.authors.find((item) => item.id === author),
				owner = labels.agents.find((item) => item.id === agent);
			const system: unknown = Reflect.get(row, "author");
			const systemName =
				canonical?.authorKind === "system"
					? "Dreaming"
					: typeof system === "object" && system !== null && Reflect.get(system, "kind") === "system"
						? resultField(system, "name")
						: undefined;
			const attribution: ResultAttribution = {
				...(author
					? { author: person ? { name: person.name, handle: person.handle } : { name: "Another person" } }
					: systemName
						? { author: { name: systemName } }
						: {}),
				...(agent ? { agent: { name: owner?.name ?? "Unavailable agent", handle: owner?.handle } } : {}),
			};
			result.push({
				...row,
				...(author || agent || systemName || ("organizationMode" in labels && labels.organizationMode)
					? { attribution }
					: {}),
			});
		}
	}
	return result;
}
export function printResultAttribution(
	row: { readonly attribution?: ResultAttribution },
	print: (value: string) => void = console.log,
): void {
	const label = renderResultAttribution(row.attribution);
	if (label) print(`  ${label}`);
}
