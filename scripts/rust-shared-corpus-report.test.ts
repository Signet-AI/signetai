import { expect, test } from "bun:test";
import { parseJUnitReport } from "./shared-corpus-runner";
import {
	extractTestsuiteFragment,
	normalizeObservedJUnitCounters,
	wrapRustJUnitReport,
} from "./rust-shared-corpus-report";

test("extracts all nested Bun describe suites from one file", () => {
	const child =
		'<testsuites><testsuite name="file" tests="2">' +
		'<testsuite name="first" tests="1"><testcase file="a.test.ts" name="one"/></testsuite>' +
		'<testsuite name="second" tests="1"><testcase file="a.test.ts" name="two"/></testsuite>' +
		"</testsuite></testsuites>";
	const fragment = extractTestsuiteFragment(child);

	expect(fragment).toContain('name="second"');
	expect(fragment?.match(/<testcase\b/g)?.length).toBe(2);
});

test("normalizes aggregate counters from observed testcase elements", () => {
	const child =
		'<testsuites tests="99" failures="98" errors="97" skipped="96"><testsuite name="a" tests="7" failures="6">' +
		'<testcase file="a.test.ts" name="one"/><testcase file="a.test.ts" name="two"><failure/></testcase></testsuite></testsuites>';
	const normalized = normalizeObservedJUnitCounters(child);

	expect(normalized).toContain('<testsuites tests="2" failures="1" errors="0" skipped="0">');
	const wrapped = wrapRustJUnitReport(normalized, true);
	expect(wrapped.xml).toContain('tests="2"');
	expect(wrapped.xml).toContain('failures="1"');
});

test("preserves child-declared JUnit totals when wrapping native evidence", () => {
	const child =
		'<?xml version="1.0"?><testsuite name="bun test" tests="2" failures="1" errors="0" skipped="0">' +
		'<testcase file="platform/core/src/database.test.ts" line="1" classname="synthetic" name="one">' +
		'<failure message="synthetic"/></testcase></testsuite>';
	const wrapped = wrapRustJUnitReport(child, false);

	expect(wrapped.caseCount).toBe(1);
	expect(wrapped.xml).toContain('nativeEvidence="false"');
	expect(wrapped.xml).toContain('tests="2"');
	expect(wrapped.xml).toContain('failures="1"');
});

test("falls back to observed case totals when Bun omits suite counters", () => {
	const child =
		'<testsuite name="bun test"><testcase file="platform/core/src/database.test.ts" ' +
		'line="1" classname="synthetic" name="one"/></testsuite>';
	const wrapped = wrapRustJUnitReport(child, true);

	expect(wrapped.caseCount).toBe(1);
	expect(wrapped.xml).toContain('nativeEvidence="true"');
	expect(wrapped.xml).toContain('tests="1"');
	expect(wrapped.xml).toContain('failures="0"');
	expect(wrapped.xml).toContain('errors="0"');
	expect(wrapped.xml).toContain('skipped="0"');
});

test("uses aggregate counters from a testsuites root", () => {
	const child =
		'<testsuites name="bun test" tests="2" failures="1" errors="0" skipped="0">' +
		'<testsuite name="a" tests="1"><testcase file="a.test.ts" name="one"/></testsuite>' +
		"</testsuites>";
	const wrapped = wrapRustJUnitReport(child, false);

	expect(wrapped.caseCount).toBe(1);
	expect(wrapped.xml).toContain('tests="2"');
	expect(wrapped.xml).toContain('failures="1"');
});

test("preserves leaf suite failures when aggregate counters are absent", () => {
	const child =
		'<testsuites><testsuite name="a" tests="1" failures="1">' +
		'<testcase file="a.test.ts" name="one"/></testsuite></testsuites>';
	const wrapped = wrapRustJUnitReport(child, false);
	const accounting = parseJUnitReport(wrapped.xml, ["a.test.ts"]);

	expect(wrapped.xml).toContain('failures="1"');
	expect(accounting.failed).toBe(1);
	expect(accounting.status).toBe("failed");
	expect(accounting.incomplete).toBe(false);
});

test("preserves nested suite errors when aggregate counters are absent", () => {
	const child =
		'<testsuite><testsuite name="a" tests="1" errors="1">' +
		'<testcase file="a.test.ts" name="one"/></testsuite></testsuite>';
	const wrapped = wrapRustJUnitReport(child, false);
	const accounting = parseJUnitReport(wrapped.xml, ["a.test.ts"]);

	expect(wrapped.xml).toContain('errors="1"');
	expect(accounting.failed).toBe(1);
	expect(accounting.status).toBe("failed");
	expect(accounting.incomplete).toBe(false);
});
