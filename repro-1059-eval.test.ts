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

	test("requires measurable backlog evidence while keeping drain separate from liveness", () => {
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
			residualBacklog: 158,
		});

		expect(result.pass).toBe(true);
		expect(result.checks.backlogMeasured).toBe(true);
		expect(result.backlogDrained).toBe(false);
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
			residualBacklog: 0,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.healthWithinBound).toBe(false);
	});
});
