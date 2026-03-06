/**
 * Tests for session checkpoint digest formatters.
 */

import { describe, expect, it } from "bun:test";
import type { ContinuityState } from "./continuity-state";
import {
	formatRecoveryDigest,
	formatPeriodicDigest,
	formatPreCompactionDigest,
	formatSessionEndDigest,
	type CheckpointRow,
} from "./session-checkpoints";

function makeState(overrides: Partial<ContinuityState> = {}): ContinuityState {
	return {
		sessionKey: "test-session",
		harness: "claude-code",
		project: "/tmp/project",
		projectNormalized: "/tmp/project",
		promptCount: 5,
		totalPromptCount: 5,
		lastCheckpointAt: Date.now() - 60_000,
		pendingQueries: [],
		pendingRemembers: [],
		pendingPromptSnippets: [],
		startedAt: Date.now() - 300_000,
		structuralSnapshot: undefined,
		...overrides,
	};
}

describe("formatPeriodicDigest", () => {
	it("includes prompt snippets when present", () => {
		const state = makeState({
			pendingPromptSnippets: ["fix the login bug", "run the test suite"],
		});
		const digest = formatPeriodicDigest(state);
		expect(digest).toContain("### Recent Prompts");
		expect(digest).toContain("- fix the login bug");
		expect(digest).toContain("- run the test suite");
	});

	it("omits prompt snippets section when empty", () => {
		const state = makeState();
		const digest = formatPeriodicDigest(state);
		expect(digest).not.toContain("### Recent Prompts");
	});

	it("includes memory activity", () => {
		const state = makeState({
			pendingQueries: ["auth", "login"],
			pendingRemembers: ["user prefers dark mode"],
		});
		const digest = formatPeriodicDigest(state);
		expect(digest).toContain("Queries: auth, login");
		expect(digest).toContain("Remembered: user prefers dark mode");
	});

	it("includes structural context ahead of prompts when present", () => {
		const state = makeState({
			structuralSnapshot: {
				focalEntityIds: ["entity-1"],
				focalEntityNames: ["signetai"],
				activeAspectIds: ["aspect-1", "aspect-2"],
				surfacedConstraintCount: 3,
				traversalMemoryCount: 24,
			},
			pendingPromptSnippets: ["fix the daemon build"],
		});
		const digest = formatPeriodicDigest(state);
		expect(digest).toContain("### Structural Context");
		expect(digest.indexOf("### Structural Context")).toBeLessThan(
			digest.indexOf("### Recent Prompts"),
		);
		expect(digest).toContain("Focal entities: signetai");
		expect(digest).toContain("Active constraints: 3");
		expect(digest).toContain("Traversal memories: 24");
	});
});

describe("formatPreCompactionDigest", () => {
	it("includes session context when provided", () => {
		const state = makeState();
		const digest = formatPreCompactionDigest(
			state,
			"Working on authentication refactor",
		);
		expect(digest).toContain("## Pre-Compaction Checkpoint");
		expect(digest).toContain("### Session Context");
		expect(digest).toContain("Working on authentication refactor");
	});

	it("omits session context section when not provided", () => {
		const state = makeState();
		const digest = formatPreCompactionDigest(state);
		expect(digest).not.toContain("### Session Context");
	});

	it("includes prompt snippets", () => {
		const state = makeState({
			pendingPromptSnippets: ["deploy to staging", "check the logs"],
		});
		const digest = formatPreCompactionDigest(state);
		expect(digest).toContain("### Recent Prompts");
		expect(digest).toContain("- deploy to staging");
		expect(digest).toContain("- check the logs");
	});

	it("includes memory activity", () => {
		const state = makeState({
			pendingQueries: ["database schema"],
			pendingRemembers: ["uses postgres"],
		});
		const digest = formatPreCompactionDigest(state);
		expect(digest).toContain("### Memory Activity");
		expect(digest).toContain("Queries: database schema");
	});
});

describe("formatSessionEndDigest", () => {
	it("produces full summary with all sections", () => {
		const state = makeState({
			promptCount: 3,
			totalPromptCount: 15,
			pendingPromptSnippets: ["final cleanup", "commit changes"],
			pendingQueries: ["deployment", "config"],
			pendingRemembers: ["project uses bun"],
		});
		const digest = formatSessionEndDigest(state);
		expect(digest).toContain("## Session End Checkpoint");
		// Uses totalPromptCount, not interval promptCount
		expect(digest).toContain("Total Prompts: 15");
		expect(digest).toContain("### Recent Prompts");
		expect(digest).toContain("- final cleanup");
		expect(digest).toContain("### Memory Activity");
		expect(digest).toContain("Queries: deployment, config");
	});

	it("handles minimal state gracefully", () => {
		const state = makeState({ promptCount: 1, totalPromptCount: 1 });
		const digest = formatSessionEndDigest(state);
		expect(digest).toContain("## Session End Checkpoint");
		expect(digest).toContain("Total Prompts: 1");
		expect(digest).not.toContain("### Recent Prompts");
		expect(digest).not.toContain("### Memory Activity");
	});
});

describe("formatRecoveryDigest", () => {
	it("preserves structural context when truncating long prompt sections", () => {
		const row: CheckpointRow = {
			id: "cp-1",
			session_key: "session-1",
			harness: "claude-code",
			project: "/tmp/project",
			project_normalized: "/tmp/project",
			trigger: "periodic",
			digest: [
				"## Session Checkpoint",
				"Project: /tmp/project",
				"Prompts: 12 | Duration: 45m",
				"",
				"### Structural Context",
				"Focal entities: signetai",
				"Active constraints: 3",
				"Traversal memories: 24",
				"",
				"### Recent Prompts",
				"- " + "x".repeat(400),
			].join("\n"),
			prompt_count: 12,
			memory_queries: null,
			recent_remembers: null,
			focal_entity_ids: JSON.stringify(["entity-1"]),
			focal_entity_names: JSON.stringify(["signetai"]),
			active_aspect_ids: JSON.stringify(["aspect-1"]),
			surfaced_constraint_count: 3,
			traversal_memory_count: 24,
			created_at: new Date().toISOString(),
		};

		const digest = formatRecoveryDigest(row, 160);
		expect(digest).toContain("### Structural Context");
		expect(digest).toContain("Focal entities: signetai");
		expect(digest).toContain("Active constraints: 3");
		expect(digest).toContain("[truncated]");
	});
});
