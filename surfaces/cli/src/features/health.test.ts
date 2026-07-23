import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExtractionStatusNotice, getStatusReport, showDoctor, showStatus } from "./health.js";

const originalHome = process.env.HOME;
const originalOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
	if (originalHome === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}

	if (originalOpenClawConfig === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.OPENCLAW_CONFIG_PATH;
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

describe("status report openclaw runtime", () => {
	it("reports legacy-only runtime when only the hook path is enabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-runtime-"));
		const workspace = join(root, "agents");
		try {
			process.env.HOME = root;
			mkdirSync(workspace, { recursive: true });
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					hooks: {
						internal: {
							entries: {
								"signet-memory": { enabled: true },
							},
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawDualSystem).toBe(false);
			expect(report.openclawRuntime).toBe("legacy");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports dual runtime when hook and plugin paths are both enabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-runtime-"));
		const workspace = join(root, "agents");
		try {
			process.env.HOME = root;
			mkdirSync(workspace, { recursive: true });
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					hooks: {
						internal: {
							entries: {
								"signet-memory": { enabled: true },
							},
						},
					},
					plugins: {
						slots: { memory: "signet-memory-openclaw" },
						entries: {
							"signet-memory-openclaw": { enabled: true },
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			const report = await getStatusReport(workspace, depsFor(workspace));
			expect(report.openclawDualSystem).toBe(true);
			expect(report.openclawRuntime).toBe("dual");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor reports OpenClaw stale heartbeat", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-runtime-"));
		const workspace = join(root, "agents");
		const lines: string[] = [];
		const oldLog = console.log;
		try {
			process.env.HOME = root;
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "AGENTS.md"), "# src\n");
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					plugins: {
						slots: { memory: "signet-memory-openclaw" },
						entries: { "signet-memory-openclaw": { enabled: true } },
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			console.log = (...args: unknown[]) => {
				lines.push(args.join(" "));
			};

			await showDoctor(
				{},
				{
					...depsFor(workspace),
					getDaemonStatus: async () => ({
						running: true,
						pid: 42,
						uptime: 10,
						version: "0.145.1",
						host: "127.0.0.1",
						bindHost: "127.0.0.1",
						networkMode: "local",
						extraction: null,
						extractionWorker: null,
						transcripts: null,
						probe: {
							status: "healthy",
							detail: "/health responded",
							url: "http://127.0.0.1:3850",
							listenerPresent: true,
							processPid: 42,
							stalePid: null,
						},
						openclaw: {
							status: "stale",
							lastHeartbeat: "2026-06-25T00:00:00.000Z",
							pluginVersion: "test-plugin",
							hooksRegistered: ["before_prompt_build"],
							hooksSucceeded: 1,
							hooksFailed: 1,
							lastLatencyMs: 42,
							lastError: "daemon returned no prompt memory injection",
						},
					}),
				},
			);

			const output = lines.join("\n");
			expect(output).toContain("OpenClaw plugin heartbeat is stale");
		} finally {
			console.log = oldLog;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor warns when openclaw is still on the legacy-only runtime path", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-runtime-"));
		const workspace = join(root, "agents");
		const lines: string[] = [];
		const oldLog = console.log;
		try {
			process.env.HOME = root;
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "AGENTS.md"), "# src\n");
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "sqlite");
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					hooks: {
						internal: {
							entries: {
								"signet-memory": { enabled: true },
							},
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;
			console.log = (...args: unknown[]) => {
				lines.push(args.join(" "));
			};

			await showDoctor({}, depsFor(workspace));

			expect(lines.join("\n")).toContain("legacy Signet hook path");
			expect(lines.join("\n")).toContain("Run `signet sync`");
		} finally {
			console.log = oldLog;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("doctor concurrent Signet installations", () => {
	it("includes a structured warning and manual npm remediation in JSON mode", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-installations-"));
		const workspace = join(root, "agents");
		const lines: string[] = [];
		const oldLog = console.log;
		try {
			mkdirSync(workspace, { recursive: true });
			console.log = (...args: unknown[]) => {
				lines.push(args.join(" "));
			};

			await showDoctor(
				{ json: true },
				{
					...depsFor(workspace),
					detectInstallations: () => ({
						target: {
							kind: "native",
							executablePath: join(root, ".local", "bin", "signet"),
						},
						installations: [],
						inactive: [
							{
								method: "npm",
								executablePath: join(root, ".npm-global", "bin", "signet"),
								packagePath: join(root, ".npm-global", "lib", "node_modules", "signetai"),
								active: false,
								removalCommand: "npm uninstall -g signetai",
							},
						],
					}),
				},
			);

			const output = JSON.parse(lines.join("\n")) as {
				installations?: { target?: { kind?: string } };
				findings?: Array<{
					code?: string;
					fix?: string;
				}>;
			};
			expect(output.installations?.target?.kind).toBe("native");
			expect(output.findings).toContainEqual(
				expect.objectContaining({
					code: "duplicate_signet_installation",
					fix: expect.stringContaining("npm uninstall -g signetai"),
				}),
			);
		} finally {
			console.log = oldLog;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("doctor physical memory diagnostics", () => {
	it("warns when daemon physical footprint exceeds one GiB", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-physical-memory-"));
		const lines: string[] = [];
		const oldLog = console.log;
		try {
			mkdirSync(root, { recursive: true });
			console.log = (...args: unknown[]) => {
				lines.push(args.join(" "));
			};

			await showDoctor(
				{ json: true },
				{
					...depsFor(root),
					getDaemonStatus: async () => ({
						running: true,
						pid: 42,
						uptime: 3600,
						version: "0.148.0",
						host: "127.0.0.1",
						bindHost: "127.0.0.1",
						networkMode: "local",
						resources: {
							rss: 169,
							heapUsed: 106,
							physicalFootprint: 6963,
							peakPhysicalFootprint: 7782,
						},
						extraction: null,
						extractionWorker: null,
						transcripts: null,
						probe: {
							status: "healthy",
							detail: "/health responded",
							url: "http://127.0.0.1:3850",
							listenerPresent: true,
							processPid: 42,
							stalePid: null,
						},
						openclaw: null,
					}),
					detectInstallations: () => ({
						target: { kind: "unsupported", executablePath: "/tmp/signet", reason: "test fixture" },
						installations: [],
						inactive: [],
					}),
				},
			);

			const output = JSON.parse(lines.join("\n")) as {
				findings?: Array<{ code?: string; message?: string; fix?: string }>;
			};
			expect(output.findings).toContainEqual(
				expect.objectContaining({
					code: "high_daemon_physical_memory",
					message: expect.stringContaining("6.8 GiB"),
					fix: expect.stringContaining("signet daemon restart"),
				}),
			);
		} finally {
			console.log = oldLog;
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

describe("showStatus readiness labeling", () => {
	function runningDaemonDeps(
		basePath: string,
		probe: {
			status: "healthy" | "degraded";
			detail: string;
			url: string;
			listenerPresent: boolean;
			processPid: number | null;
			stalePid: number | null;
			readinessReasons?: readonly string[];
		},
	) {
		return {
			...depsFor(basePath),
			getDaemonStatus: async () => ({
				running: true,
				pid: 42,
				uptime: 10,
				version: "0.148.0",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "local",
				extraction: null,
				extractionWorker: null,
				transcripts: null,
				probe,
				openclaw: null,
			}),
		};
	}

	async function captureStatus(deps: ReturnType<typeof runningDaemonDeps>): Promise<string> {
		const lines: string[] = [];
		const oldLog = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.join(" "));
		};
		try {
			await showStatus({}, deps);
		} finally {
			console.log = oldLog;
		}
		return lines.join("\n");
	}

	it("labels liveness and shows degraded readiness reasons", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-status-"));
		try {
			const output = await captureStatus(
				runningDaemonDeps(root, {
					status: "degraded",
					detail: "/health responded; readiness degraded",
					url: "http://127.0.0.1:3850",
					listenerPresent: true,
					processPid: 42,
					stalePid: null,
					readinessReasons: ["pending migrations"],
				}),
			);
			expect(output).toContain("Daemon running");
			expect(output).toContain("(live)");
			expect(output).toContain("Readiness degraded: pending migrations");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps status output unchanged when the daemon is ready", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-status-"));
		try {
			const output = await captureStatus(
				runningDaemonDeps(root, {
					status: "healthy",
					detail: "/health responded",
					url: "http://127.0.0.1:3850",
					listenerPresent: true,
					processPid: 42,
					stalePid: null,
				}),
			);
			expect(output).toContain("Daemon running");
			expect(output).not.toContain("(live)");
			expect(output).not.toContain("Readiness degraded");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
