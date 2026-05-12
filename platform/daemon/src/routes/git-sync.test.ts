import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitConfig, loadGitConfig } from "./git-config";
import {
	getAutoCommitQueueStateForTests,
	getGitStatus,
	resetGitHealthForTests,
	scheduleAutoCommit,
	setGitCommandRunnerForTests,
	setGitRepoProbeForTests,
	stopGitSyncTimer,
} from "./git-sync";
import { type GitConfig, applyGitConfigPatch } from "./session-routes";

describe("loadGitConfig", () => {
	it("keeps background git automation disabled by default", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-config-"));
		try {
			const cfg = loadGitConfig(root);
			expect(cfg.enabled).toBe(true);
			expect(cfg.autoCommit).toBe(false);
			expect(cfg.autoSync).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows users to explicitly opt into background git automation", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-config-"));
		try {
			writeFileSync(join(root, "agent.yaml"), "git:\n  autoCommit: true\n  autoSync: true\n");
			const cfg = loadGitConfig(root);
			expect(cfg.autoCommit).toBe(true);
			expect(cfg.autoSync).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("applyGitConfigPatch", () => {
	it("ignores malformed boolean values instead of truthily enabling auto commit", () => {
		const cfg: GitConfig = {
			enabled: true,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300000,
			remote: "origin",
			branch: "main",
		};

		applyGitConfigPatch(cfg, { autoCommit: "false" as unknown as boolean, autoSync: "true" as unknown as boolean });

		expect(cfg.autoCommit).toBe(false);
		expect(cfg.autoSync).toBe(false);
	});

	it("still allows explicit boolean opt-in", () => {
		const cfg: GitConfig = {
			enabled: true,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300000,
			remote: "origin",
			branch: "main",
		};

		applyGitConfigPatch(cfg, { autoCommit: true, autoSync: true });

		expect(cfg.autoCommit).toBe(true);
		expect(cfg.autoSync).toBe(true);
	});
});

describe("getGitStatus", () => {
	it("degrades instead of throwing when workspace status times out", async () => {
		resetGitHealthForTests();
		setGitRepoProbeForTests(() => true);
		setGitCommandRunnerForTests(async (_cmd, args) => {
			if (args[0] === "remote") return { code: 1, stdout: "", stderr: "no remote" };
			if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
			if (args[0] === "status") return { code: 124, stdout: "", stderr: "", timedOut: true };
			return { code: 0, stdout: "0\n", stderr: "" };
		});

		try {
			const status = await getGitStatus();
			expect(status.isRepo).toBe(true);
			expect(status.branch).toBe("main");
			expect(status.degraded).toBe(true);
			expect(status.degradedReason).toContain("Workspace status timed out");
			expect(status.uncommittedChanges).toBeUndefined();
		} finally {
			setGitCommandRunnerForTests(null);
			setGitRepoProbeForTests(null);
			resetGitHealthForTests();
		}
	});

	it("opens a cheap degraded circuit after repeated git status failures", async () => {
		resetGitHealthForTests();
		setGitRepoProbeForTests(() => true);
		let calls = 0;
		setGitCommandRunnerForTests(async (_cmd, args) => {
			calls += 1;
			if (args[0] === "remote") return { code: 1, stdout: "", stderr: "no remote" };
			if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
			if (args[0] === "status") return { code: 124, stdout: "", stderr: "", timedOut: true };
			return { code: 0, stdout: "0\n", stderr: "" };
		});

		try {
			await getGitStatus();
			await getGitStatus();
			await getGitStatus();
			const callsBeforeCircuit = calls;

			const status = await getGitStatus();
			expect(status.degraded).toBe(true);
			expect(status.degradedReason).toContain("temporarily disabled");
			expect(calls).toBe(callsBeforeCircuit);
		} finally {
			setGitCommandRunnerForTests(null);
			setGitRepoProbeForTests(null);
			resetGitHealthForTests();
		}
	});
});

describe("scheduleAutoCommit", () => {
	it("does not queue background commits when autoCommit is disabled", async () => {
		const previous = gitConfig.autoCommit;
		gitConfig.autoCommit = false;
		try {
			scheduleAutoCommit("/tmp/AGENTS.md");
			expect(getAutoCommitQueueStateForTests()).toEqual({ pending: false, queued: 0 });
		} finally {
			gitConfig.autoCommit = previous;
			await stopGitSyncTimer();
		}
	});

	it("queues background commits only after explicit opt-in", async () => {
		const previous = gitConfig.autoCommit;
		gitConfig.autoCommit = true;
		try {
			scheduleAutoCommit("/tmp/AGENTS.md");
			expect(getAutoCommitQueueStateForTests()).toEqual({ pending: true, queued: 1 });
		} finally {
			gitConfig.autoCommit = previous;
			await stopGitSyncTimer();
		}
	});
});
