import { describe, expect, test } from "bun:test";
import { caseCoverageIncomplete, type CaseBackendEvidence } from "./shared-corpus-runner";

describe("shared-corpus per-case backend attribution", () => {
	test("Rust is incomplete when cases remain unverified despite batch evidence", () => {
		const cases: CaseBackendEvidence[] = [
			{ identity: "core.test.ts:1:core", file: "platform/core/core.test.ts", backend: "rust" },
			{ identity: "daemon.test.ts:1:daemon", file: "platform/daemon/daemon.test.ts", backend: "unverified" },
		];
		expect(caseCoverageIncomplete("rust", cases)).toBe(true);
	});

	test("Rust requires at least one attributed case", () => {
		expect(caseCoverageIncomplete("rust", [])).toBe(true);
	});

	test("all Rust-attributed cases satisfy case-level coverage", () => {
		const cases: CaseBackendEvidence[] = [
			{ identity: "core.test.ts:1:core", file: "platform/core/core.test.ts", backend: "rust" },
		];
		expect(caseCoverageIncomplete("rust", cases)).toBe(false);
	});

	test("TypeScript runs do not require Rust case evidence", () => {
		const cases: CaseBackendEvidence[] = [
			{ identity: "core.test.ts:1:core", file: "platform/core/core.test.ts", backend: "typescript" },
		];
		expect(caseCoverageIncomplete("typescript", cases)).toBe(false);
	});
});
