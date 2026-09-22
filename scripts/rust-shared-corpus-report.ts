const TESTCASE_PATTERN = /<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g;

export type WrappedRustJUnitReport = {
	readonly xml: string;
	readonly cases: string[];
	readonly caseCount: number;
};

function attribute(source: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? "";
}

function numericAttribute(source: string, name: string, fallback: number): string {
	const value = attribute(source, name);
	return /^\d+$/.test(value) ? value : String(fallback);
}

/** Preserve Bun's declared totals while adding native evidence for the parent runner. */
export function wrapRustJUnitReport(reportXml: string, nativeEvidence: boolean): WrappedRustJUnitReport {
	const cases = reportXml.match(TESTCASE_PATTERN) ?? [];
	if (cases.length === 0) throw new Error("Rust child produced no real testcase identities");
	const rootOpening = reportXml.match(/<testsuites\b[^>]*>/)?.[0] ?? reportXml.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
	const observedFailures = cases.filter((testcase) => /<failure\b/.test(testcase)).length;
	const observedErrors = cases.filter((testcase) => /<error\b/.test(testcase)).length;
	const observedSkipped = cases.filter((testcase) => /<skipped\b/.test(testcase)).length;
	const tests = numericAttribute(rootOpening, "tests", cases.length);
	const failures = numericAttribute(rootOpening, "failures", observedFailures);
	const errors = numericAttribute(rootOpening, "errors", observedErrors);
	const skipped = numericAttribute(rootOpening, "skipped", observedSkipped);
	return {
		cases,
		caseCount: cases.length,
		xml: `<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" nativeEvidence="${nativeEvidence ? "true" : "false"}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">${cases.join("")}</testsuite>`,
	};
}
