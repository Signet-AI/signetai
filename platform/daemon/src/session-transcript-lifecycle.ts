import { resolveDefaultBasePath } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { dbOwnerTranscriptOperation, getDbOwnerForAccessor } from "./db-owner-runtime";
import { bypassSession, unbypassSession } from "./session-tracker";
import type { writeTranscriptAudit } from "./transcript-audit";
import type {
	appendCanonicalTranscriptTurns,
	writeCanonicalTranscriptSnapshot,
	appendCanonicalTranscriptSnapshotIfMissing,
} from "./transcript-jsonl";

export type TranscriptCaptureInput =
	| { readonly kind: "audit"; readonly input: Parameters<typeof writeTranscriptAudit>[0] }
	| { readonly kind: "backfill"; readonly input: Parameters<typeof appendCanonicalTranscriptSnapshotIfMissing>[0] }
	| {
			readonly kind: "snapshot";
			readonly input: Omit<Parameters<typeof writeCanonicalTranscriptSnapshot>[0], "onLegacySessionReplaced">;
	  }
	| { readonly kind: "turns"; readonly input: Parameters<typeof appendCanonicalTranscriptTurns>[0] }
	| {
			readonly kind: "promotion";
			readonly input: {
				readonly basePath: string;
				readonly agentId: string;
				readonly harness: string;
				readonly sessionKey: null;
				readonly replacements: readonly {
					readonly identity: import("./transcript-jsonl").TranscriptIdentity;
					readonly transcript: string;
				}[];
			};
	  };

export type TranscriptLifecycleInput =
	| {
			readonly agentId: string;
			readonly sessionKey: string;
			readonly action: "start" | "end" | "status";
	  }
	| { readonly action: "restore"; readonly after?: readonly [string, string] };

export interface TranscriptBypass {
	readonly agent_id: string;
	readonly session_key: string;
}

export async function restoreTranscriptBypasses(): Promise<void> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	let after: readonly [string, string] | undefined;
	for (;;) {
		const page = await dbOwnerTranscriptOperation<readonly TranscriptBypass[]>(
			owner,
			{ kind: "session_transcript_lifecycle", input: { action: "restore", after } },
			{ operation: "transcripts.restore-bypass", deadlineMs: 2_000 },
		);
		for (const row of page) bypassSession(row.session_key, { allowUnknown: true, untilEnd: true }, row.agent_id);
		const last = page.at(-1);
		if (page.length < 100 || !last) return;
		after = [last.agent_id, last.session_key];
	}
}

export interface TranscriptLifecycleResult {
	readonly generation: number;
	readonly bypassed: boolean;
}

export async function updateTranscriptLifecycle(
	input: Exclude<TranscriptLifecycleInput, { readonly action: "restore" }>,
): Promise<TranscriptLifecycleResult> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	const result = await dbOwnerTranscriptOperation<TranscriptLifecycleResult>(
		owner,
		{ kind: "session_transcript_lifecycle", input },
		{ operation: "transcripts.lifecycle", deadlineMs: 2_000 },
	);
	if (result.bypassed) bypassSession(input.sessionKey, { allowUnknown: true, untilEnd: true }, input.agentId);
	if (!result.bypassed && result.generation > 0) unbypassSession(input.sessionKey, input.agentId, true);
	return result;
}

export async function captureTranscriptOwned<Result>(input: TranscriptCaptureInput): Promise<Result> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	return await dbOwnerTranscriptOperation<Result>(
		owner,
		{ kind: "session_transcript_capture", input },
		{ operation: "transcripts.capture", deadlineMs: 30_000 },
	);
}

export interface TranscriptDeleteInput {
	readonly basePath: string;
	readonly sessionKey: string;
	readonly agentId: string;
	readonly project?: string;
	readonly hard: boolean;
	readonly changedBy: string;
	readonly live?: { readonly harness: string; readonly project: string | null };
}

export type TranscriptDeleteResult =
	| { readonly status: "not_found" }
	| {
			readonly status: "complete" | "pending";
			readonly counts: Readonly<Record<string, number>>;
			readonly retainedPinned: number;
			readonly generation: number;
			readonly bypassed: boolean;
			readonly pendingReason?: string;
	  };

export async function deleteSessionTranscript(
	input: Omit<TranscriptDeleteInput, "basePath">,
	signal?: AbortSignal,
): Promise<TranscriptDeleteResult> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	const result = await dbOwnerTranscriptOperation<TranscriptDeleteResult>(
		owner,
		{ kind: "session_transcript_delete", input: { ...input, basePath: resolveDefaultBasePath() } },
		{ operation: "transcripts.delete", lane: "write", deadlineMs: 10_000, signal },
	);
	if (result.status !== "not_found" && result.bypassed) {
		bypassSession(input.sessionKey, { allowUnknown: true, untilEnd: true }, input.agentId);
	}
	return result;
}
