import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampGitSyncIntervalSeconds, gitConfig, loadGitConfig } from "./git-config";
import {
	getAutoCommitQueueStateForTests,
	getGitStatus,
	gitAutoCommitForTests,
	resetGitHealthForTests,
	scheduleAutoCommit,
	setGitCommandRunnerForTests,
	setGitRepoProbeForTests,
	stopGitSyncTimer,
	toRelativeGitPathForTests,
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

	it("clamps sync interval to a safe background range", () => {
		expect(clampGitSyncIntervalSeconds(1)).toBe(60);
		expect(clampGitSyncIntervalSeconds("30")).toBe(60);
		expect(clampGitSyncIntervalSeconds(120)).toBe(120);
		expect(clampGitSyncIntervalSeconds(100_000)).toBe(86_400);
		expect(clampGitSyncIntervalSeconds("nope")).toBeNull();
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

describe("git auto-commit scoping", () => {
	it("normalizes equivalent watcher paths before converting them to git pathspecs", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-paths-"));
		const link = `${root}-link`;
		try {
			mkdirSync(join(root, "nested"));
			writeFileSync(join(root, "nested", "AGENTS.md"), "identity");
			symlinkSync(root, link, "dir");

			expect(toRelativeGitPathForTests(root, join(root, "nested", "..", "nested", "AGENTS.md"))).toBe(
				"nested/AGENTS.md",
			);
			expect(toRelativeGitPathForTests(root, join(link, "nested", "AGENTS.md"))).toBe("nested/AGENTS.md");
			expect(toRelativeGitPathForTests(root, join(root, "..", "outside.md"))).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(link, { recursive: true, force: true });
		}
	});

	it("commits only queued auto-commit pathspecs instead of the whole index", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-autocommit-"));
		const previous = gitConfig.autoCommit;
		const calls: string[][] = [];
		try {
			gitConfig.autoCommit = true;
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, "AGENTS.md"), "identity");
			setGitRepoProbeForTests(() => true);
			setGitCommandRunnerForTests(async (_cmd, args) => {
				calls.push(args);
				if (args[0] === "status") return { code: 0, stdout: "M AGENTS.md\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			});

			await gitAutoCommitForTests(root, [join(root, "AGENTS.md")]);

			const commit = calls.find((args) => args[0] === "commit");
			expect(commit).toBeDefined();
			expect(commit).toContain("--");
			expect(commit?.slice((commit?.indexOf("--") ?? -1) + 1)).toEqual([":(literal)AGENTS.md"]);
		} finally {
			gitConfig.autoCommit = previous;
			setGitCommandRunnerForTests(null);
			setGitRepoProbeForTests(null);
			resetGitHealthForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops database backup paths from daemon auto-commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-autocommit-"));
		const previous = gitConfig.autoCommit;
		const calls: string[][] = [];
		try {
			gitConfig.autoCommit = true;
			mkdirSync(join(root, ".git"));
			mkdirSync(join(root, "memory"));
			writeFileSync(join(root, "AGENTS.md"), "identity");
			writeFileSync(join(root, "memory", "memories.db.bak-v1-1"), "db backup");
			setGitRepoProbeForTests(() => true);
			setGitCommandRunnerForTests(async (_cmd, args) => {
				calls.push(args);
				if (args[0] === "status") return { code: 0, stdout: "M AGENTS.md\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			});

			await gitAutoCommitForTests(root, [join(root, "AGENTS.md"), join(root, "memory", "memories.db.bak-v1-1")]);

			const add = calls.find((args) => args[0] === "add");
			expect(add?.join(" ")).toContain("AGENTS.md");
			expect(add?.join(" ")).not.toContain("memories.db");
		} finally {
			gitConfig.autoCommit = previous;
			setGitCommandRunnerForTests(null);
			setGitRepoProbeForTests(null);
			resetGitHealthForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("commits protected removals created by recursive untracking", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-git-autocommit-"));
		const previous = gitConfig.autoCommit;
		const calls: string[][] = [];
		try {
			gitConfig.autoCommit = true;
			mkdirSync(join(root, ".git"));
			setGitRepoProbeForTests(() => true);
			setGitCommandRunnerForTests(async (_cmd, args) => {
				calls.push(args);
				if (args[0] === "diff") return { code: 0, stdout: "memory/memories.db.bak-v1-1\0", stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: "D  memory/memories.db.bak-v1-1\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			});

			await gitAutoCommitForTests(root, [join(root, "memory", "memories.db.bak-v1-1")]);

			const rm = calls.find((args) => args[0] === "rm");
			expect(rm).toContain("-r");
			const commit = calls.find((args) => args[0] === "commit");
			expect(commit?.join(" ")).toContain("memory/memories.db.bak-v1-1");
		} finally {
			gitConfig.autoCommit = previous;
			setGitCommandRunnerForTests(null);
			setGitRepoProbeForTests(null);
			resetGitHealthForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
