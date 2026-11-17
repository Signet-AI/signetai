export interface SingleRememberResult {
	readonly chunked?: false;
	readonly id: string;
	readonly type?: string;
	readonly tags?: string | null;
	readonly pinned?: boolean;
	readonly importance?: number;
	readonly content?: string;
	readonly embedded?: boolean;
	readonly deduped?: boolean;
}

export interface ChunkedRememberResult {
	readonly chunked: true;
	readonly chunk_count: number;
	readonly ids: readonly string[];
	readonly group_id: string;
	readonly deduped?: boolean;
}

export type RememberResult = SingleRememberResult | ChunkedRememberResult;

export function parseRememberResponse(value: unknown): RememberResult {
	if (typeof value !== "object" || value === null) throw new Error("Invalid remember response");
	if ("chunked" in value && value.chunked === true) {
		if (
			!("ids" in value) ||
			!Array.isArray(value.ids) ||
			value.ids.length === 0 ||
			!value.ids.every((id): id is string => typeof id === "string" && id.length > 0) ||
			!("chunk_count" in value) ||
			value.chunk_count !== value.ids.length ||
			!("group_id" in value) ||
			typeof value.group_id !== "string" ||
			value.group_id.length === 0
		)
			throw new Error("Invalid chunked remember response");
		return {
			chunked: true,
			ids: value.ids,
			chunk_count: value.chunk_count,
			group_id: value.group_id,
			deduped: "deduped" in value && value.deduped === true,
		};
	}
	const id = "id" in value ? value.id : "memoryId" in value ? value.memoryId : undefined;
	if (typeof id !== "string" || id.length === 0) throw new Error("Invalid remember response: missing memory ID");
	return {
		id,
		type: "type" in value && typeof value.type === "string" ? value.type : undefined,
		content: "content" in value && typeof value.content === "string" ? value.content : undefined,
		tags:
			"tags" in value
				? typeof value.tags === "string"
					? value.tags
					: value.tags === null
						? null
						: undefined
				: undefined,
		pinned: "pinned" in value && typeof value.pinned === "boolean" ? value.pinned : undefined,
		importance: "importance" in value && typeof value.importance === "number" ? value.importance : undefined,
		embedded: "embedded" in value && typeof value.embedded === "boolean" ? value.embedded : undefined,
		deduped: "deduped" in value && value.deduped === true,
	};
}
