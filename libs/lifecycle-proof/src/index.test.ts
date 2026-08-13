import { describe, expect, it } from "bun:test";
import { assertLifecycleInvariants, type LifecycleObservation, type LifecycleProofInput } from "./index";

function proofEvidence(): Pick<LifecycleProofInput, "shutdown" | "slowProvider"> {
	return {
		shutdown: {
			startedAtMs: 100,
			completedAtMs: 150,
			budgetMs: 200,
			startedWork: 0,
			pendingWork: 0,
			completedWork: 0,
			abandonedWork: 0,
		},
		slowProvider: {
			startedAtMs: 100,
			completedAtMs: 2_000,
			promptHandledAtMs: 150,
		},
	};
}

function baseObservations(): LifecycleObservation[] {
	return [
		{ stage: "startup", sequence: 1 },
		{ stage: "session-start", sessionId: "old", contextGeneration: 1, sequence: 2 },
		{
			stage: "prompt-submit",
			sessionId: "old",
			turn: 1,
			state: "completed",
			sourceSessionId: "old",
			targetSessionId: "old",
			sequence: 3,
		},
		{ stage: "session-end", sessionId: "old", state: "completed", sequence: 4 },
		{ stage: "session-switch", fromSessionId: "old", toSessionId: "new", sequence: 5 },
		{ stage: "session-start", sessionId: "new", contextGeneration: 2, sequence: 6 },
		{
			stage: "restart",
			workId: "queued-job",
			state: "queued",
			sourceSessionId: "old",
			targetSessionId: "old",
			sequence: 7,
		},
		{
			stage: "restart",
			workId: "queued-job",
			state: "replayable",
			sourceSessionId: "old",
			targetSessionId: "old",
			sequence: 8,
		},
	];
}

function validInput(observations = baseObservations()): LifecycleProofInput {
	return { observations, ...proofEvidence() };
}

describe("cross-harness lifecycle proof", () => {
	it("proves the complete contract from owner observations", () => {
		const result = assertLifecycleInvariants(validInput());
		expect(result.invariants).toHaveLength(9);
		expect(result.observations).toBe(8);
		expect(result.workStateCounts).toEqual({ completed: 2, queued: 1, abandoned: 0, replayable: 1 });
	});

	it("rejects lifecycle work recorded before startup", () => {
		const observations = baseObservations().map((observation) =>
			observation.stage === "session-start" ? { ...observation, sequence: 0 } : observation,
		);
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow("startup precedes lifecycle work");
	});

	it("rejects completed turns that are not serialized within a session", () => {
		const observations = [
			...baseObservations(),
			{
				stage: "prompt-submit" as const,
				sessionId: "old",
				turn: 3,
				state: "completed" as const,
				sourceSessionId: "old",
				targetSessionId: "old",
				sequence: 9,
			},
		];
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow("completed turns are serialized");
	});

	it("rejects interrupted work that is marked durable", () => {
		const observations = [
			...baseObservations(),
			{
				stage: "prompt-submit" as const,
				workId: "turn-2",
				interrupted: true,
				state: "completed" as const,
				sourceSessionId: "old",
				targetSessionId: "old",
				sequence: 9,
			},
		];
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow(
			"interrupted turns are not durable semantic input",
		);
	});

	it("rejects a session switch before the old session end", () => {
		const observations = baseObservations().map((observation) =>
			observation.stage === "session-end" ? { ...observation, sequence: 6 } : observation,
		);
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow("session end precedes session switch");
	});

	it("rejects queued work that has no restart outcome", () => {
		const observations = baseObservations().filter(
			(observation) => !(observation.stage === "restart" && observation.state === "replayable"),
		);
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow("restart resolves queued work");
	});

	it("rejects a queued item resolved by a non-restart completion", () => {
		const observations = [
			...baseObservations(),
			{
				stage: "prompt-submit" as const,
				workId: "queued-job",
				state: "completed" as const,
				sourceSessionId: "old",
				targetSessionId: "old",
				sequence: 9,
			},
		].filter((observation) => !(observation.stage === "restart" && observation.state === "replayable"));
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow("restart resolves queued work");
	});

	it("rejects shutdown that exceeds its bounded drain window", () => {
		expect(() =>
			assertLifecycleInvariants({
				...validInput(),
				shutdown: { ...proofEvidence().shutdown, completedAtMs: 301, budgetMs: 200 },
			}),
		).toThrow("shutdown is bounded and reports abandoned work");
	});

	it("rejects shutdown counts that do not account for all pending work", () => {
		expect(() =>
			assertLifecycleInvariants({
				...validInput(),
				shutdown: { ...proofEvidence().shutdown, startedWork: 2, abandonedWork: 1 },
			}),
		).toThrow("shutdown is bounded and reports abandoned work");
	});

	it("rejects a slow provider that delays prompt handling", () => {
		expect(() =>
			assertLifecycleInvariants({
				...validInput(),
				slowProvider: { ...proofEvidence().slowProvider, promptHandledAtMs: 2_000 },
			}),
		).toThrow("slow providers do not block prompt handling");
	});

	it("rejects context reuse after an invalidation", () => {
		const observations = [
			...baseObservations(),
			{
				stage: "session-start" as const,
				sessionId: "new",
				invalidation: "rewind" as const,
				contextGeneration: 3,
				sequence: 9,
			},
			{
				stage: "prompt-submit" as const,
				sessionId: "new",
				contextGeneration: 2,
				sourceSessionId: "new",
				targetSessionId: "new",
				sequence: 10,
			},
		];
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow(
			"invalidated context generations cannot be reused",
		);
	});

	it("rejects work attributed to a different session", () => {
		const observations = [
			...baseObservations(),
			{
				stage: "session-end" as const,
				workId: "old-session-end",
				sourceSessionId: "old",
				targetSessionId: "new",
				sequence: 9,
			},
		];
		expect(() => assertLifecycleInvariants(validInput(observations))).toThrow(
			"work remains attributed to its source session",
		);
	});

	it("rejects proof input without shutdown or slow-provider evidence", () => {
		expect(() =>
			assertLifecycleInvariants({ observations: baseObservations() } as unknown as LifecycleProofInput),
		).toThrow("shutdown evidence was not recorded");
	});
});
