export type ChildTermination = Readonly<{
	exitCode: number | null;
	signalCode: string | null;
}>;

export type HarnessEvaluationInput = Readonly<{
	expectedSubmissions: number;
	posted: number;
	postErrors: number;
	daemonExited: boolean;
	liveSamples: number;
	liveSuccessfulSamples: number;
	liveP95Ms: number;
	backlogObserved: boolean;
	residualBacklog: number | null;
}>;

export type HarnessEvaluation = Readonly<{
	pass: boolean;
	checks: Readonly<{
		acceptedAll: boolean;
		daemonStayedAlive: boolean;
		livenessWithinBound: boolean;
		backlogMeasured: boolean;
	}>;
	backlogDrained: boolean | null;
}>;

export const MAX_LIVE_P95_MS = 1_000;

export function termination(child: ChildTermination): Readonly<{
	exited: boolean;
	exitCode: number | null;
	signal: string | null;
}> {
	return {
		exited: child.exitCode !== null || child.signalCode !== null,
		exitCode: child.exitCode,
		signal: child.signalCode,
	};
}

export function evaluate(input: HarnessEvaluationInput): HarnessEvaluation {
	const checks = {
		acceptedAll: input.posted === input.expectedSubmissions && input.postErrors === 0,
		daemonStayedAlive: !input.daemonExited,
		livenessWithinBound:
			input.liveSamples > 0 && input.liveSuccessfulSamples === input.liveSamples && input.liveP95Ms <= MAX_LIVE_P95_MS,
		backlogMeasured: input.backlogObserved && input.residualBacklog !== null,
	};
	return {
		pass: Object.values(checks).every(Boolean),
		checks,
		backlogDrained: input.residualBacklog === null ? null : input.residualBacklog === 0,
	};
}
