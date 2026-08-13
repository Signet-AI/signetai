/**
 * Cross-harness lifecycle proof helpers.
 *
 * This package owns no queues, timers, providers, or session state. Harnesses
 * and the daemon record observations from their existing lifecycle owners, then
 * use assertLifecycleInvariants() to check the shared contract.
 */

export const LIFECYCLE_STAGES = [
	"startup",
	"session-start",
	"prompt-submit",
	"session-end",
	"session-switch",
	"restart",
	"shutdown",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type LifecycleWorkState = "completed" | "queued" | "abandoned" | "replayable";
export type LifecycleInvalidation = "branch" | "resume" | "compression" | "rewind";

export interface LifecycleObservation {
	readonly stage: LifecycleStage;
	readonly workId?: string;
	readonly sessionId?: string;
	readonly sourceSessionId?: string;
	readonly targetSessionId?: string;
	readonly fromSessionId?: string;
	readonly toSessionId?: string;
	readonly turn?: number;
	readonly state?: LifecycleWorkState;
	readonly interrupted?: boolean;
	readonly invalidation?: LifecycleInvalidation;
	readonly contextGeneration?: number;
	readonly sequence: number;
}

export interface LifecycleShutdownWindow {
	readonly startedAtMs: number;
	readonly completedAtMs: number;
	readonly budgetMs: number;
	/** Work present when shutdown began. */
	readonly startedWork: number;
	/** Work still pending when shutdown completed. */
	readonly pendingWork: number;
	readonly completedWork: number;
	readonly abandonedWork: number;
}

export interface LifecycleProviderWindow {
	readonly startedAtMs: number;
	readonly completedAtMs: number;
	readonly promptHandledAtMs: number;
}

export interface LifecycleProofInput {
	readonly observations: readonly LifecycleObservation[];
	readonly shutdown?: LifecycleShutdownWindow;
	readonly slowProvider?: LifecycleProviderWindow;
}

export interface LifecycleProofResult {
	readonly invariants: readonly string[];
	readonly observations: number;
	readonly workStateCounts: Readonly<Record<LifecycleWorkState, number>>;
}

export const LIFECYCLE_INVARIANTS = [
	"startup precedes lifecycle work",
	"completed turns are serialized",
	"interrupted turns are not durable semantic input",
	"session end precedes session switch",
	"invalidated context generations cannot be reused",
	"restart resolves queued work",
	"shutdown is bounded and reports abandoned work",
	"slow providers do not block prompt handling",
	"work remains attributed to its source session",
] as const;

function fail(invariant: string, detail: string): never {
	throw new Error(`Lifecycle invariant failed: ${invariant}. ${detail}`);
}

function observationsFor(
	observations: readonly LifecycleObservation[],
	stage: LifecycleStage,
): readonly LifecycleObservation[] {
	return observations.filter((observation) => observation.stage === stage);
}

function assertStartupPrecedesWork(observations: readonly LifecycleObservation[]): void {
	const startup = observations.find((observation) => observation.stage === "startup");
	if (!startup) fail(LIFECYCLE_INVARIANTS[0], "no startup observation was recorded");
	const work = observations.filter((observation) => observation.stage !== "startup");
	if (work.some((observation) => observation.sequence <= startup.sequence)) {
		fail(LIFECYCLE_INVARIANTS[0], "a lifecycle observation occurred before startup completed");
	}
}

function assertCompletedTurnsSerialized(observations: readonly LifecycleObservation[]): void {
	const completedBySession = new Map<string, LifecycleObservation[]>();
	for (const observation of observations) {
		if (observation.state !== "completed" || observation.turn === undefined) continue;
		if (!observation.sessionId) fail(LIFECYCLE_INVARIANTS[1], "a completed turn has no session attribution");
		const completed = completedBySession.get(observation.sessionId) ?? [];
		completed.push(observation);
		completedBySession.set(observation.sessionId, completed);
	}
	for (const completed of completedBySession.values()) {
		completed.sort((left, right) => left.sequence - right.sequence);
		for (let index = 1; index < completed.length; index += 1) {
			const previous = completed[index - 1]?.turn;
			const current = completed[index]?.turn;
			if (previous !== undefined && current !== undefined && current <= previous) {
				fail(LIFECYCLE_INVARIANTS[1], `turn ${String(current)} completed after turn ${String(previous)}`);
			}
		}
	}
}

function assertInterruptedTurnsAreNotDurable(observations: readonly LifecycleObservation[]): void {
	const invalid = observations.find(
		(observation) => observation.interrupted === true && observation.state === "completed",
	);
	if (invalid) fail(LIFECYCLE_INVARIANTS[2], `interrupted work ${invalid.workId ?? "<unknown>"} was marked completed`);
}

function assertEndPrecedesSwitch(observations: readonly LifecycleObservation[]): void {
	const ended = new Map<string, number>();
	for (const observation of observationsFor(observations, "session-end")) {
		if (observation.sessionId) ended.set(observation.sessionId, observation.sequence);
	}
	for (const observation of observationsFor(observations, "session-switch")) {
		const previousSessionId = observation.fromSessionId ?? observation.sessionId;
		if (!previousSessionId) continue;
		const endSequence = ended.get(previousSessionId);
		if (endSequence === undefined || endSequence > observation.sequence) {
			fail(LIFECYCLE_INVARIANTS[3], `session ${previousSessionId} switched before its end was recorded`);
		}
	}
}

function assertInvalidatedContextIsNotReused(observations: readonly LifecycleObservation[]): void {
	const latestGeneration = new Map<string, { readonly generation: number; readonly invalidated: boolean }>();
	for (const observation of [...observations].sort((left, right) => left.sequence - right.sequence)) {
		if (!observation.sessionId || observation.contextGeneration === undefined) continue;
		const previous = latestGeneration.get(observation.sessionId);
		if (
			observation.invalidation !== undefined &&
			previous !== undefined &&
			observation.contextGeneration <= previous.generation
		) {
			fail(
				LIFECYCLE_INVARIANTS[4],
				`invalidation ${observation.invalidation} reused context generation ${observation.contextGeneration}`,
			);
		}
		if (
			observation.invalidation === undefined &&
			previous !== undefined &&
			(observation.contextGeneration < previous.generation ||
				(previous.invalidated && observation.contextGeneration <= previous.generation))
		) {
			fail(LIFECYCLE_INVARIANTS[4], `context generation reused or regressed from ${previous.generation}`);
		}
		latestGeneration.set(observation.sessionId, {
			generation: observation.contextGeneration,
			invalidated: observation.invalidation !== undefined,
		});
	}
}

function assertRestartResolvesQueuedWork(observations: readonly LifecycleObservation[]): void {
	const queued = observations.filter((observation) => observation.state === "queued" && observation.workId);
	const resolved = observations.filter(
		(observation) =>
			(observation.state === "completed" || observation.state === "abandoned" || observation.state === "replayable") &&
			observation.workId,
	);
	for (const queuedObservation of queued) {
		const hasOutcome = resolved.some(
			(observation) =>
				observation.workId === queuedObservation.workId && observation.sequence > queuedObservation.sequence,
		);
		if (!hasOutcome) {
			fail(LIFECYCLE_INVARIANTS[5], `queued work ${queuedObservation.workId} has no replayable or abandoned outcome`);
		}
	}
}

function assertShutdownBounded(window: LifecycleShutdownWindow | undefined): void {
	if (!window) return;
	if (
		window.budgetMs < 0 ||
		window.startedWork < 0 ||
		window.pendingWork < 0 ||
		window.completedWork < 0 ||
		window.abandonedWork < 0 ||
		window.completedAtMs < window.startedAtMs
	) {
		fail(LIFECYCLE_INVARIANTS[6], "shutdown timestamps or counts are invalid");
	}
	if (window.completedAtMs - window.startedAtMs > window.budgetMs) {
		fail(LIFECYCLE_INVARIANTS[6], "shutdown exceeded its drain budget");
	}
	if (window.startedWork !== window.pendingWork + window.completedWork + window.abandonedWork) {
		fail(LIFECYCLE_INVARIANTS[6], "shutdown work was not exactly accounted for as pending, completed, or abandoned");
	}
}

function assertSlowProviderDoesNotBlockPrompt(window: LifecycleProviderWindow | undefined): void {
	if (!window) return;
	if (
		window.startedAtMs < 0 ||
		window.completedAtMs < window.startedAtMs ||
		window.promptHandledAtMs < window.startedAtMs
	) {
		fail(LIFECYCLE_INVARIANTS[7], "provider timing is invalid");
	}
	if (window.promptHandledAtMs >= window.completedAtMs) {
		fail(LIFECYCLE_INVARIANTS[7], "prompt handling waited for the slow provider");
	}
}

function assertWorkAttribution(observations: readonly LifecycleObservation[]): void {
	const mismatched = observations.find((observation) => {
		const hasSource = observation.sourceSessionId !== undefined;
		const hasTarget = observation.targetSessionId !== undefined;
		return hasSource !== hasTarget || (hasSource && observation.sourceSessionId !== observation.targetSessionId);
	});
	if (mismatched) {
		fail(
			LIFECYCLE_INVARIANTS[8],
			`work ${mismatched.workId ?? "<unknown>"} targets session ${mismatched.targetSessionId}`,
		);
	}
}

function countWorkStates(observations: readonly LifecycleObservation[]): Readonly<Record<LifecycleWorkState, number>> {
	const counts: Record<LifecycleWorkState, number> = {
		completed: 0,
		queued: 0,
		abandoned: 0,
		replayable: 0,
	};
	for (const observation of observations) {
		if (observation.state !== undefined) counts[observation.state] += 1;
	}
	return counts;
}

/** Assert the shared lifecycle contract against observations from real owners. */
export function assertLifecycleInvariants(input: LifecycleProofInput): LifecycleProofResult {
	assertStartupPrecedesWork(input.observations);
	assertCompletedTurnsSerialized(input.observations);
	assertInterruptedTurnsAreNotDurable(input.observations);
	assertEndPrecedesSwitch(input.observations);
	assertInvalidatedContextIsNotReused(input.observations);
	assertRestartResolvesQueuedWork(input.observations);
	assertShutdownBounded(input.shutdown);
	assertSlowProviderDoesNotBlockPrompt(input.slowProvider);
	assertWorkAttribution(input.observations);
	return {
		invariants: LIFECYCLE_INVARIANTS,
		observations: input.observations.length,
		workStateCounts: countWorkStates(input.observations),
	};
}
