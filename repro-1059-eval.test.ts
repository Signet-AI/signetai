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
			backlogObserved: true,
			residualBacklog: 158,
		});

		expect(result.pass).toBe(true);
		expect(result.checks.backlogMeasured).toBe(true);
		expect(result.backlogDrained).toBe(false);
	});

	test("fails when the daemon exits or liveness samples exceed the bound", () => {
		const result = evaluate({
			expectedSubmissions: 180,
			posted: 180,
			postErrors: 0,
			daemonExited: true,
			liveSamples: 10,
			liveSuccessfulSamples: 9,
			liveP95Ms: 1_001,
			backlogObserved: true,
			residualBacklog: 0,
		});

		expect(result.pass).toBe(false);
		expect(result.checks.daemonStayedAlive).toBe(false);
		expect(result.checks.livenessWithinBound).toBe(false);
	});
});
