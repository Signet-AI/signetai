const TESTCASE_PATTERN = /<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g;

type SuiteCounters = {
	tests?: number;
	failures?: number;
	errors?: number;
	skipped?: number;
};

export type WrappedRustJUnitReport = {
	readonly xml: string;
	readonly cases: string[];
	readonly caseCount: number;
};

function attribute(source: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? "";
}

function numericAttribute(source: string, name: string): number | undefined {
	const value = attribute(source, name);
	return /^\d+$/.test(value) ? Number(value) : undefined;
}

function suiteCounters(attributes: string): SuiteCounters {
	return {
		tests: numericAttribute(attributes, "tests"),
		failures: numericAttribute(attributes, "failures"),
		errors: numericAttribute(attributes, "errors"),
		skipped: numericAttribute(attributes, "skipped"),
	};
}

function aggregateLeafSuiteCounters(reportXml: string): SuiteCounters {
	const stack: Array<{ attributes: string; childSuites: number }> = [];
	const leaves: SuiteCounters[] = [];
	const tags = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite\s*>/g;
	for (const match of reportXml.matchAll(tags)) {
		if (match[1] !== undefined) {
			const node = { attributes: match[1] ?? "", childSuites: 0 };
			const parent = stack.at(-1);
			if (parent) parent.childSuites += 1;
			if (match[2] === "/") leaves.push(suiteCounters(node.attributes));
			else stack.push(node);
			continue;
		}
		const node = stack.pop();
		if (node && node.childSuites === 0) leaves.push(suiteCounters(node.attributes));
	}
	const sum = (name: keyof SuiteCounters): number | undefined => {
		const values = leaves.map((leaf) => leaf[name]).filter((value): value is number => value !== undefined);
		return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
	};
	return {
		tests: sum("tests"),
		failures: sum("failures"),
		errors: sum("errors"),
		skipped: sum("skipped"),
	};
}

function outputCounter(source: string, name: keyof SuiteCounters, fallback: number, aggregate: SuiteCounters): string {
	const rootValue = numericAttribute(source, name);
	if (rootValue !== undefined) return String(rootValue);
	const aggregateValue = aggregate[name];
	return String(aggregateValue ?? fallback);
}

/** Preserve Bun's declared totals while adding native evidence for the parent runner. */
export function wrapRustJUnitReport(reportXml: string, nativeEvidence: boolean): WrappedRustJUnitReport {
	const cases = reportXml.match(TESTCASE_PATTERN) ?? [];
	if (cases.length === 0) throw new Error("Rust child produced no real testcase identities");
	const rootOpening = reportXml.match(/<testsuites\b[^>]*>/)?.[0] ?? reportXml.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
	const aggregate = aggregateLeafSuiteCounters(reportXml);
	const observedFailures = cases.filter((testcase) => /<failure\b/.test(testcase)).length;
	const observedErrors = cases.filter((testcase) => /<error\b/.test(testcase)).length;
	const observedSkipped = cases.filter((testcase) => /<skipped\b/.test(testcase)).length;
	const tests = outputCounter(rootOpening, "tests", cases.length, aggregate);
	const failures = outputCounter(rootOpening, "failures", observedFailures, aggregate);
	const errors = outputCounter(rootOpening, "errors", observedErrors, aggregate);
	const skipped = outputCounter(rootOpening, "skipped", observedSkipped, aggregate);
	return {
		cases,
		caseCount: cases.length,
		xml: `<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" nativeEvidence="${nativeEvidence ? "true" : "false"}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">${cases.join("")}</testsuite>`,
	};
}
