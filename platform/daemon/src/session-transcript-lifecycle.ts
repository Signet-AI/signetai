import { withSessionArtifactLease, SessionArtifactLeaseTimeoutError } from "./session-artifact-lease";
import { resolveDefaultBasePath } from "@signet/core";
import {
	rememberTranscriptLifecycleSequence,
	withTranscriptLifecycleIntents,
	type TranscriptLifecycleIntent,
} from "./transcript-lifecycle-intents";
import { getDbAccessor } from "./db-accessor";
import { dbOwnerTranscriptOperation, getDbOwnerForAccessor } from "./db-owner-runtime";
import { bypassSession, unbypassSession } from "./session-tracker";
import type { writeTranscriptAudit } from "./transcript-audit";
import {
	appendCanonicalTranscriptTurns,
	writeCanonicalTranscriptSnapshot,
	appendCanonicalTranscriptSnapshotIfMissing,
	canonicalTranscriptPath,
	rewriteReplacingLiveOnlySessions,
	withTranscriptFileLock,
	TranscriptLockTimeoutError,
	sessionSeqCacheKey,
	type CanonicalTranscriptRecord,
} from "./transcript-jsonl";

export type TranscriptCaptureInput = (
	| { readonly kind: "audit"; readonly input: Parameters<typeof writeTranscriptAudit>[0] }
	| { readonly kind: "backfill"; readonly input: Parameters<typeof appendCanonicalTranscriptSnapshotIfMissing>[0] }
	| {
			readonly kind: "snapshot";
			readonly input: Omit<Parameters<typeof writeCanonicalTranscriptSnapshot>[0], "onLegacySessionReplaced"> & {
				readonly rawTranscript?: string;
			};
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
	  }
) & { readonly input: { readonly basePath: string } };

export type TranscriptCaptureAdmission =
	| { readonly status: "admitted"; readonly capture: Exclude<TranscriptCaptureInput, { readonly kind: "audit" }> }
	| import("./transcript-audit").TranscriptAuditWrite
	| null;

export type TranscriptLifecycleInput =
	| {
			readonly agentId: string;
			readonly sessionKey: string;
			readonly action: "start" | "end" | "status";
			readonly intents?: readonly TranscriptLifecycleIntent[];
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
	readonly lifecycleIntentSeq: number;
}

export async function updateTranscriptLifecycle(
	input: Exclude<TranscriptLifecycleInput, { readonly action: "restore" }>,
): Promise<TranscriptLifecycleResult> {
	const result = await withTranscriptLifecycleIntents(input, async (intents) => {
		const owner = await getDbOwnerForAccessor(getDbAccessor());
		return dbOwnerTranscriptOperation<TranscriptLifecycleResult>(
			owner,
			{ kind: "session_transcript_lifecycle", input: { ...input, intents } },
			{ operation: "transcripts.lifecycle", deadlineMs: 2_000 },
		);
	});
	if (result.bypassed) bypassSession(input.sessionKey, { allowUnknown: true, untilEnd: true }, input.agentId);
	if (!result.bypassed && result.generation > 0)
		unbypassSession(input.sessionKey, input.agentId, input.action === "status" ? "deletion" : true);
	return result;
}

export interface TranscriptCapturePending {
	readonly status: "pending";
	readonly pendingReason: string;
}

export class TranscriptCapturePendingError extends Error {
	readonly status = "pending";
	constructor(reason: string) {
		super(reason);
		this.name = "TranscriptCapturePendingError";
	}
}

export function captureTranscriptOwned(
	input: Extract<TranscriptCaptureInput, { kind: "audit" }>,
): Promise<import("./transcript-audit").TranscriptAuditWrite | null>;
export function captureTranscriptOwned(input: Extract<TranscriptCaptureInput, { kind: "turns" }>): Promise<boolean>;
export function captureTranscriptOwned(
	input: Extract<TranscriptCaptureInput, { kind: "snapshot" }>,
): Promise<readonly CanonicalTranscriptRecord[] | null>;
export function captureTranscriptOwned(
	input: Extract<TranscriptCaptureInput, { kind: "backfill" }>,
): Promise<string | null>;
export function captureTranscriptOwned(
	input: Extract<TranscriptCaptureInput, { kind: "promotion" }>,
): Promise<readonly string[]>;
export async function captureTranscriptOwned(
	input: TranscriptCaptureInput,
): Promise<
	| import("./transcript-audit").TranscriptAuditWrite
	| readonly CanonicalTranscriptRecord[]
	| readonly string[]
	| string
	| boolean
	| null
> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	const admit = async (): Promise<TranscriptCaptureAdmission> => {
		return dbOwnerTranscriptOperation<TranscriptCaptureAdmission>(
			owner,
			{ kind: "session_transcript_capture", input },
			{ operation: "transcripts.capture", deadlineMs: 2_000 },
		);
	};
	if (input.kind === "audit") {
		const result = await admit();
		if (result === null || "latestPath" in result) return result;
		throw new Error("Invalid transcript audit admission");
	}
	try {
		return await withTranscriptFileLock(
			canonicalTranscriptPath(input.input.basePath, input.input.harness),
			async () => {
				const admitted = await admit();
				if (!admitted) return input.kind === "turns" ? false : input.kind === "promotion" ? [] : null;
				if (!("capture" in admitted)) throw new Error("Invalid canonical transcript admission");
				const capture = admitted.capture;
				if (capture.kind === "turns") return appendCanonicalTranscriptTurns(capture.input, { lockHeld: true });
				if (capture.kind === "snapshot") return writeCanonicalTranscriptSnapshot(capture.input, { lockHeld: true });
				if (capture.kind === "backfill")
					return appendCanonicalTranscriptSnapshotIfMissing(capture.input, undefined, { lockHeld: true });
				const replacements = new Map(
					capture.input.replacements.map((entry) => [sessionSeqCacheKey(entry.identity), entry]),
				);
				await rewriteReplacingLiveOnlySessions(
					canonicalTranscriptPath(capture.input.basePath, capture.input.harness),
					replacements,
					{ lockHeld: true },
				);
				return [...replacements.keys()];
			},
			{ timeoutMs: 250 },
		);
	} catch (error) {
		if (error instanceof TranscriptLockTimeoutError) throw new TranscriptCapturePendingError(error.message);
		throw error;
	}
}

export interface TranscriptDeleteInput {
	readonly readScope?: import("./read-scope").ReadScope;
	readonly generation?: number;
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
	| { readonly status: "conflict"; readonly generation: number }
	| {
			readonly status: "complete" | "pending";
			readonly lifecycleIntentSeq: number;
			readonly counts: Readonly<Record<string, number>>;
			readonly retainedPinned: number;
			readonly generation: number;
			readonly bypassed: boolean;
			readonly pendingReason?: string;
	  };

export async function deleteSessionTranscript(
	input: Omit<TranscriptDeleteInput, "basePath">,
	signal?: AbortSignal,
): Promise<TranscriptDeleteResult | TranscriptCapturePending> {
	const owner = await getDbOwnerForAccessor(getDbAccessor());
	try {
		const result = await withSessionArtifactLease(input, true, async () =>
			dbOwnerTranscriptOperation<TranscriptDeleteResult>(
				owner,
				{
					kind: "session_transcript_delete",
					input: { ...input, basePath: resolveDefaultBasePath() },
				},
				{ operation: "transcripts.delete", lane: "write", deadlineMs: 10_000, signal },
			),
		);
		if (result.status === "complete" || result.status === "pending")
			rememberTranscriptLifecycleSequence(result.lifecycleIntentSeq);
		if ((result.status === "complete" || result.status === "pending") && result.bypassed) {
			bypassSession(input.sessionKey, { allowUnknown: true, untilEnd: true }, input.agentId);
		}
		return result;
	} catch (error) {
		if (error instanceof SessionArtifactLeaseTimeoutError) return { status: "pending", pendingReason: error.message };
		throw error;
	}
}
