import { expect, test } from "bun:test";
import { normalizeObservedJUnitCounters } from "./rust-shared-corpus-report";

test("refuses to normalize away per-file declared JUnit counter mismatches", () => {
	const report =
		'<testsuites><testsuite name="a" tests="3" failures="0"><testcase file="a.test.ts" name="one"/><testcase file="a.test.ts" name="two"/></testsuite></testsuites>';
	expect(() => normalizeObservedJUnitCounters(report)).toThrow(/declared/i);
});
