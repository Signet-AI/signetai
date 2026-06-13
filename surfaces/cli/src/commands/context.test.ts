import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	buildContextCompilePrompt,
	compileContextPrompt,
	readContextSources,
} from "./context";

function tempWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "signet-context-compile-"));
}

describe("context compile", () => {
	it("builds a synthesis prompt from canonical identity sources", () => {
		const root = tempWorkspace();
		writeFileSync(join(root, "AGENTS.md"), "# Policy\nPreserve user files.");
		writeFileSync(join(root, "USER.md"), "# User\nPrefers concise coding context.");

		const sources = readContextSources(root, ["AGENTS.md", "USER.md", "SOUL.md"]);
		const prompt = buildContextCompilePrompt(sources, 2200);

		expect(sources.map((source) => source.path)).toEqual(["AGENTS.md", "USER.md"]);
		expect(prompt).toContain("2200 characters or fewer");
		expect(prompt).toContain("Preserve user files");
		expect(prompt).toContain("Drop biography");
	});

	it("writes a profile artifact with a hard character cap", async () => {
		const root = tempWorkspace();
		writeFileSync(join(root, "AGENTS.md"), "# Policy\nPreserve user files.");
		writeFileSync(join(root, "USER.md"), "# User\nPrefers concise coding context.");
		const longText = `${"a".repeat(80)}\n${"b".repeat(80)}`;

		const result = await compileContextPrompt({
			agentsDir: root,
			profile: "coding",
			outputPath: "context-profiles/coding/AGENTS.md",
			sourceFiles: ["AGENTS.md", "USER.md"],
			maxChars: 100,
			timeoutMs: 1000,
			dryRun: false,
			secretApiCall: async (_method, path, body, timeoutMs) => {
				expect(path).toBe("/api/inference/execute");
				const request = body as { operation?: string; taskClass?: string; privacy?: string; timeoutMs?: number };
				expect(request.operation).toBe("session_synthesis");
				expect(request.taskClass).toBeUndefined();
				expect(request.privacy).toBeUndefined();
				expect(request.timeoutMs).toBe(1000);
				expect(timeoutMs).toBe(6000);
				return { ok: true, data: { text: longText, decision: { targetRef: "local/default" } } };
			},
		});

		expect(result.charCount).toBeLessThanOrEqual(100);
		expect(result.truncated).toBe(true);
		expect(result.targetRef).toBe("local/default");
		expect(readFileSync(join(root, "context-profiles/coding/AGENTS.md"), "utf-8").length).toBeLessThanOrEqual(101);
	});

	it("rejects source and output paths that escape protected workspace areas", async () => {
		const root = tempWorkspace();
		mkdirSync(join(root, ".secrets"));
		writeFileSync(join(root, ".secrets", "AGENTS.md"), "secret");
		symlinkSync(join(root, ".secrets", "AGENTS.md"), join(root, "SAFE.md"));
		expect(() => readContextSources(root, [".secrets/AGENTS.md"])).toThrow("Unsafe context path");
		expect(() => readContextSources(root, ["SAFE.md"])).toThrow("Context path escapes workspace");

		const outside = tempWorkspace();
		writeFileSync(join(outside, "AGENTS.md"), "outside");
		mkdirSync(join(root, "context-profiles"));
		symlinkSync(outside, join(root, "context-profiles", "escape"));
		writeFileSync(join(root, "AGENTS.md"), "# Policy\nNo secrets.");
		let apiCalls = 0;

		await expect(
			compileContextPrompt({
				agentsDir: root,
				profile: "coding",
				outputPath: "context-profiles/escape/AGENTS.md",
				sourceFiles: ["AGENTS.md"],
				maxChars: 100,
				timeoutMs: 1000,
				dryRun: false,
				secretApiCall: async () => {
					apiCalls += 1;
					return { ok: true, data: { text: "compiled" } };
				},
			}),
		).rejects.toThrow("Context path escapes workspace");
		expect(apiCalls).toBe(0);

		writeFileSync(join(outside, "artifact.md"), "outside");
		symlinkSync(join(outside, "artifact.md"), join(root, "context-profiles", "AGENTS.md"));
		await expect(
			compileContextPrompt({
				agentsDir: root,
				profile: "coding",
				outputPath: "context-profiles/AGENTS.md",
				sourceFiles: ["AGENTS.md"],
				maxChars: 100,
				timeoutMs: 1000,
				dryRun: false,
				secretApiCall: async () => {
					apiCalls += 1;
					return { ok: true, data: { text: "compiled" } };
				},
			}),
		).rejects.toThrow("must not be a symlink");
		expect(apiCalls).toBe(0);
	});
});
