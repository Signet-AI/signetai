import { getDbAccessor } from "./db-accessor";
import { getDbOwnerForAccessor } from "./db-owner-runtime";

export const MEMORY_HEAD_MAX_TOKENS = 1000;
export type MemoryHeadWriteResult =
	| { readonly ok: true; readonly revision: number }
	| { readonly ok: false; readonly error: string; readonly code?: "busy" | "invalid" | "unavailable" };

export type MemoryHeadRequest =
	| { readonly action: "read"; readonly agentId: string }
	| { readonly action: "inspect"; readonly agentId: string; readonly content: string }
	| {
			readonly action: "commit";
			readonly input: {
				readonly agentId: string;
				readonly passId: string;
				readonly baseRevision: number;
				readonly baseHash: string;
				readonly entries: readonly {
					readonly entryId: string;
					readonly text: string;
					readonly support: readonly Record<string, unknown>[];
				}[];
			};
	  };

export async function requestMemoryHead<Result>(request: MemoryHeadRequest): Promise<Result> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	return owner.submit<Result>(
		{ kind: "memory_head", request },
		{ operation: `memory-head.${request.action}`, lane: "write", deadlineMs: 5000, estimatedWorkUnits: 1000 },
	).result;
}

/** Unversioned callers cannot prove which evidence produced their text. */
export function writeMemoryHead(
	_content: string,
	_opts?: { readonly agentId?: string; readonly owner?: string },
): MemoryHeadWriteResult {
	return {
		ok: false,
		code: "invalid",
		error: "Legacy synthesis writer disabled; curated memory head is authoritative",
	};
}

export type MemoryHeadResult = {
	readonly ok: boolean;
	readonly code?: string;
	readonly error?: string;
	readonly revision?: number;
	readonly hash?: string;
	readonly changedIds?: readonly string[];
};
export function readCuratedMemoryHead(agentId: string): Promise<Record<string, unknown>> {
	return requestMemoryHead({ action: "read", agentId });
}
export function commitCuratedMemoryHead(
	input: Extract<MemoryHeadRequest, { action: "commit" }>["input"],
): Promise<MemoryHeadResult> {
	return requestMemoryHead({ action: "commit", input });
}
