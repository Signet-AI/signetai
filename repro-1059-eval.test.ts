import { describe, expect, test } from "bun:test";
import { evaluate, termination } from "./repro-1059-eval";

describe("sustained-ingestion harness evaluation", () => {
	test("does not treat a signal-killed daemon as alive", () => {
		expect(termination({ exitCode: null, signalCode: "SIGKILL" })).toEqual({
			exited: true,
			exitCode: null,
			signal: "SIGKILL",
		});
	});

	test("requires a non-increasing backlog while allowing a residual queue", () => {
		const result = evaluate({
			expectedSubmissions: 180,
			posted: 180,
			postErrors: 0,
			daemonExited: false,
			liveSamples: 359,
			liveSuccessfulSamples: 359,
			liveP95Ms: 45,
			liveMaxMs: 45,
			healthSamples: 359,
			healthSuccessfulSamples: 359,
			healthP95Ms: 4,
			healthMaxMs: 4,
			backlogObserved: true,
			backlogSnapshotFailures: 0,
			backlogSamples: [180, 170, 158],
			residualBacklog: 158,
		});

		expect(result.pass).toBe(true);
		expect(result.checks.backlogMeasured).toBe(true);
		expect(result.checks.backlogNonIncreasing).toBe(true);
		expect(result.backlogDrained).toBe(false);
	});

	test("fails when the residual backlog grows during the fixed observation window", () => {
		const result = evaluate({
			expectedSubmissions: 2,
			posted: 2,
			postErrors: 0,
			daemonExited: false,
			liveSamples: 2,
			liveSuccessfulSamples: 2,
			liveP95Ms: 1,
			liveMaxMs: 1,
			healthSamples: 2,
			healthSuccessfulSamples: 2,
			healthP95Ms: 1,
			healthMaxMs: 1,
			backlogObserved: true,
			backlogSnapshotFailures: 0,
			backlogSamples: [1, 2],
			residualBacklog: 2,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.backlogMeasured).toBe(true);
		expect(result.checks.backlogNonIncreasing).toBe(false);
	});

	test("fails when the daemon exits or the liveness tail exceeds the bound", () => {
		const result = evaluate({
			expectedSubmissions: 180,
			posted: 180,
			postErrors: 0,
			daemonExited: false,
			liveSamples: 10,
			liveSuccessfulSamples: 10,
			liveP95Ms: 900,
			liveMaxMs: 1_001,
			healthSamples: 10,
			healthSuccessfulSamples: 10,
			healthP95Ms: 1,
			healthMaxMs: 1,
			backlogObserved: true,
			backlogSnapshotFailures: 0,
			backlogSamples: [0],
			residualBacklog: 0,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.daemonStayedAlive).toBe(true);
		expect(result.checks.livenessWithinBound).toBe(false);
	});

	test("fails when health samples are bad even if liveness samples pass", () => {
		const result = evaluate({
			expectedSubmissions: 1,
			posted: 1,
			postErrors: 0,
			daemonExited: false,
			liveSamples: 1,
			liveSuccessfulSamples: 1,
			liveP95Ms: 1,
			liveMaxMs: 1,
			healthSamples: 1,
			healthSuccessfulSamples: 0,
			healthP95Ms: 1,
			healthMaxMs: 1,
			backlogObserved: true,
			backlogSnapshotFailures: 0,
			backlogSamples: [0],
			residualBacklog: 0,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.healthWithinBound).toBe(false);
	});

	test("fails when every backlog snapshot is a failed document-list request", () => {
		const result = evaluate({
			expectedSubmissions: 180,
			posted: 180,
			postErrors: 0,
			daemonExited: false,
			liveSamples: 3,
			liveSuccessfulSamples: 3,
			liveP95Ms: 1,
			liveMaxMs: 1,
			healthSamples: 3,
			healthSuccessfulSamples: 3,
			healthP95Ms: 1,
			healthMaxMs: 1,
			backlogObserved: false,
			backlogSnapshotFailures: 3,
			backlogSamples: [],
			residualBacklog: null,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.backlogMeasured).toBe(false);
		expect(result.checks.backlogSnapshotsHealthy).toBe(false);
		expect(result.checks.backlogNonIncreasing).toBe(false);
	});
});
