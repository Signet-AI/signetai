import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExtractionStatusNotice, getStatusReport } from "./health.js";

const originalOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
	if (originalOpenClawConfig === undefined) {
		process.env.OPENCLAW_CONFIG_PATH = undefined;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = originalOpenClawConfig;
	}
});

function depsFor(basePath: string) {
	return {
		agentsDir: basePath,
		defaultPort: 3850,
		detectExistingSetup: () => ({
			agentsDir: true,
			agentsMd: true,
			agentYaml: true,
			memoryDb: false,
		}),
		extractPathOption: () => null,
		formatUptime: () => "0s",
		getDaemonStatus: async () => ({
			running: false,
			pid: null,
			uptime: null,
			version: null,
			host: null,
			bindHost: null,
			networkMode: null,
		}),
		normalizeAgentPath: (pathValue: string) => pathValue,
		parseIntegerValue: (value: unknown) => (typeof value === "number" ? value : null),
		signetLogo: () => "signet",
	};
}

describe("status report openclaw backup risk", () => {
	it("marks workspace as unprotected when openclaw is linked and origin is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("clears unprotected flag when origin exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			spawnSync("git", ["remote", "add", "origin", "git@github.com:test/private.git"], {
				cwd: workspace,
				windowsHide: true,
			});
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(false);
			expect(report.git.origin).toContain("private.git");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats linked workspace as protected when snapshot marker points to an existing backup", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "AGENTS.md"), "# src\n");
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "sqlite");
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const snapshotPath = join(root, "backups", "agents-20260327T120000Z");
			mkdirSync(join(snapshotPath, "memory"), { recursive: true });
			writeFileSync(join(snapshotPath, "AGENTS.md"), "# snap\n");
			writeFileSync(join(snapshotPath, "agent.yaml"), "version: 1\n");
			writeFileSync(join(snapshotPath, "SOUL.md"), "soul\n");
			writeFileSync(join(snapshotPath, "IDENTITY.md"), "identity\n");
			writeFileSync(join(snapshotPath, "USER.md"), "user\n");
			writeFileSync(join(snapshotPath, "MEMORY.md"), "memory\n");
			writeFileSync(join(snapshotPath, "memory", "memories.db"), "sqlite");
			mkdirSync(join(snapshotPath, ".git"), { recursive: true });
			writeFileSync(
				join(workspace, ".signet-workspace-protection.json"),
				`${JSON.stringify({
					source: workspace,
					snapshot: snapshotPath,
					createdAt: new Date().toISOString(),
				})}\n`,
			);

			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(false);
			expect(report.git.snapshot).toBe(snapshotPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores snapshot markers when backup is stale", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "AGENTS.md"), "# src\n");
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "sqlite");
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const snapshotPath = join(root, "backups", "agents-20260327T120000Z");
			mkdirSync(join(snapshotPath, "memory"), { recursive: true });
			writeFileSync(join(snapshotPath, "AGENTS.md"), "# snap\n");
			writeFileSync(join(snapshotPath, "agent.yaml"), "version: 1\n");
			writeFileSync(join(snapshotPath, "SOUL.md"), "soul\n");
			writeFileSync(join(snapshotPath, "IDENTITY.md"), "identity\n");
			writeFileSync(join(snapshotPath, "USER.md"), "user\n");
			writeFileSync(join(snapshotPath, "MEMORY.md"), "memory\n");
			writeFileSync(join(snapshotPath, "memory", "memories.db"), "sqlite");
			mkdirSync(join(snapshotPath, ".git"), { recursive: true });
			const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			writeFileSync(
				join(workspace, ".signet-workspace-protection.json"),
				`${JSON.stringify({
					source: workspace,
					snapshot: snapshotPath,
					createdAt: stale,
				})}\n`,
			);

			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(true);
			expect(report.git.snapshot).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores snapshot markers when snapshot content is incomplete", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "AGENTS.md"), "# src\n");
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "sqlite");
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const snapshotPath = join(root, "backups", "agents-20260327T120000Z");
			mkdirSync(join(snapshotPath, "memory"), { recursive: true });
			writeFileSync(join(snapshotPath, "AGENTS.md"), "# partial\n");
			writeFileSync(join(snapshotPath, "memory", "memories.db"), "sqlite");
			writeFileSync(
				join(workspace, ".signet-workspace-protection.json"),
				`${JSON.stringify({
					source: workspace,
					snapshot: snapshotPath,
					createdAt: new Date().toISOString(),
				})}\n`,
			);

			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(true);
			expect(report.git.snapshot).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores snapshot markers that point inside the workspace tree", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-risk-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			spawnSync("git", ["init"], { cwd: workspace, windowsHide: true });
			const nested = join(workspace, "backups", "nested");
			mkdirSync(nested, { recursive: true });
			writeFileSync(
				join(workspace, ".signet-workspace-protection.json"),
				`${JSON.stringify({
					source: workspace,
					snapshot: nested,
					createdAt: new Date().toISOString(),
				})}\n`,
			);

			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawWorkspaceLinked).toBe(true);
			expect(report.openclawWorkspaceUnprotected).toBe(true);
			expect(report.git.snapshot).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("getExtractionStatusNotice", () => {
	it("returns a warning for degraded extraction", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "claude-code",
				effective: "ollama",
				fallbackProvider: "ollama",
				status: "degraded",
				degraded: true,
				reason: "Claude Code CLI not found during extraction startup preflight",
				since: "2026-03-26T00:00:00.000Z",
			},
			extractionWorker: null,
		});

		expect(notice).toEqual({
			level: "warn",
			title: "Extraction degraded",
			detail:
				"configured: claude-code, effective: ollama — Claude Code CLI not found during extraction startup preflight",
		});
	});

	it("returns an error for blocked extraction", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "claude-code",
				effective: "none",
				fallbackProvider: "none",
				status: "blocked",
				degraded: true,
				reason: "Claude Code CLI not found during extraction startup preflight; fallbackProvider is none",
				since: "2026-03-26T00:00:00.000Z",
			},
			extractionWorker: null,
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
		expect(notice?.detail).toContain("fallback: none");
	});

	it("returns a warning when extraction worker is load-shedding", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: null,
			extractionWorker: {
				running: true,
				overloaded: true,
				loadPerCpu: 1.82,
				maxLoadPerCpu: 0.8,
				overloadBackoffMs: 30000,
				overloadSince: "2026-03-26T00:00:00.000Z",
				nextTickInMs: 28000,
			},
		});

		expect(notice).toEqual({
			level: "warn",
			title: "Pipeline load-shedding",
			detail: "load/core 1.82 > threshold 0.80 — next tick in 28s",
		});
	});

	it("prioritizes blocked extraction over load-shedding warning", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "claude-code",
				effective: "none",
				fallbackProvider: "none",
				status: "blocked",
				degraded: true,
				reason: "Claude Code CLI not found during extraction startup preflight; fallbackProvider is none",
				since: "2026-03-26T00:00:00.000Z",
			},
			extractionWorker: {
				running: true,
				overloaded: true,
				loadPerCpu: 1.82,
				maxLoadPerCpu: 0.8,
				overloadBackoffMs: 30000,
				overloadSince: "2026-03-26T00:00:00.000Z",
				nextTickInMs: 28000,
			},
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
	});
});
