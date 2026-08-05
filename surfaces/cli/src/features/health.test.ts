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
								removalCommand: `rm -f -- '${join(root, ".npm-global", "bin", "signet")}'`,
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
					fix: expect.stringContaining("rm -f --"),
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
				blockedBy: ["missing credential for extraction", "account state missing"],
				since: "2026-03-26T00:00:00.000Z",
			},
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
		expect(notice?.detail).toBe(
			"configured: claude-code, fallback: none — Claude Code CLI not found during extraction startup preflight; fallbackProvider is none — blocked by: missing credential for extraction; account state missing",
		);
	});

	it("returns an error when extraction is blocked", () => {
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
		});

		expect(notice?.level).toBe("error");
		expect(notice?.title).toBe("Extraction blocked");
	});

	// Regression (#946): the standalone extraction worker was retired, so the
	// daemon reports an active route as ready even though workerRunning is false.
	// This must NOT produce a misleading "Extraction worker stopped" notice.
	it("does not warn when an active route is ready despite the retired worker", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "command",
				resolved: "command",
				effective: "command",
				fallbackProvider: "none",
				status: "active",
				degraded: false,
				reason: null,
				blockedBy: [],
				since: null,
				enabled: true,
				paused: false,
				workerRunning: false,
				ready: true,
				blockedReason: null,
				hasWorkloadState: true,
			},
		});

		expect(notice).toBeNull();
	});

	it("does not surface a pipeline notice when the extraction pipeline is retired", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: "command",
				resolved: "command",
				effective: "none",
				fallbackProvider: "none",
				status: "disabled",
				degraded: false,
				reason: "Dreaming cutover owns semantic writes",
				blockedBy: [],
				since: null,
				enabled: false,
				paused: false,
				workerRunning: false,
				ready: false,
				blockedReason: null,
				hasWorkloadState: true,
			},
		});

		expect(notice).toBeNull();
	});

	it("still warns that the pipeline is disabled when no retirement reason is present", () => {
		const notice = getExtractionStatusNotice({
			running: true,
			pid: 1,
			uptime: 10,
			version: "0.0.1",
			host: "127.0.0.1",
			bindHost: "127.0.0.1",
			networkMode: "local",
			extraction: {
				configured: null,
				resolved: null,
				effective: null,
				fallbackProvider: "none",
				status: "disabled",
				degraded: false,
				reason: null,
				blockedBy: [],
				since: null,
				enabled: false,
				paused: false,
				workerRunning: false,
				ready: false,
				blockedReason: null,
				hasWorkloadState: true,
			},
		});

		expect(notice?.level).toBe("warn");
		expect(notice?.title).toBe("Pipeline disabled");
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

	// Regression (#1074): a daemon whose event loop is wedged keeps its TCP
	// listener (and often its process) alive while /health times out. That is
	// "unresponsive", not "stopped" — a restart re-triggers the same wedge, so
	// the label must not send the operator down the restart path.
	it("labels an alive-but-unresponsive daemon as unresponsive, not stopped", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-status-"));
		try {
			const deps = {
				...depsFor(root),
				getDaemonStatus: async () => ({
					running: false,
					pid: 42,
					uptime: null,
					version: null,
					host: null,
					bindHost: null,
					networkMode: null,
					probe: {
						status: "listener-unhealthy" as const,
						detail:
							"TCP listener is present on http://127.0.0.1:3850, but /health did not return successfully within the probe timeout",
						url: "http://127.0.0.1:3850",
						listenerPresent: true,
						processPid: 42,
						stalePid: null,
					},
				}),
			};
			const output = await captureStatus(deps);
			expect(output).toContain("Daemon unresponsive");
			expect(output).toContain("not answering");
			expect(output).not.toContain("Daemon stopped");
			expect(output).not.toContain("signet daemon restart");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("dead-job backlog surfacing (#1048)", () => {
	const queueFixture = {
		memory: {
			pending: 0,
			leased: 0,
			completed: 8548,
			failed: 0,
			dead: 10952,
			oldestAgeSec: 0,
			oldestDeadAgeSec: 86400 * 9,
			lastError: "LLM extraction failed: All routing candidates were blocked by policy or runtime state.",
		},
		summary: {
			pending: 0,
			leased: 0,
			completed: 2204,
			failed: 0,
			dead: 275,
			oldestAgeSec: 0,
			oldestDeadAgeSec: 86400 * 3,
			lastError: "All routed targets failed.",
		},
	};

	function deadBacklogDeps(basePath: string, withHealth = true) {
		return {
			...depsFor(basePath),
			getDaemonStatus: async () => ({
				running: true,
				pid: 3046866,
				uptime: 54,
				version: "0.156.4",
				host: "127.0.0.1",
				bindHost: "127.0.0.1",
				networkMode: "local",
				extraction: null,
				transcripts: { pending: 0, failed: 0, dead: 0 },
				health: withHealth ? { score: 0.817, status: "unhealthy" } : null,
				queue: queueFixture,
				probe: {
					status: "healthy" as const,
					detail: "/health responded",
					url: "http://127.0.0.1:3850",
					listenerPresent: true,
					processPid: 42,
					stalePid: null,
				},
				openclaw: null,
			}),
		};
	}

	async function captureStatus(deps: ReturnType<typeof deadBacklogDeps>): Promise<string> {
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

	it("status visibly warns about the dead-job backlog and its last error", async () => {
		const root = mkdtempSync(join(tmpdir(), "health-dead-backlog-"));
		try {
			const output = await captureStatus(deadBacklogDeps(root));
			expect(output).toContain("Pipeline queues (dead jobs present)");
			expect(output).toContain("d=10952");
			expect(output).toContain("d=275");
			expect(output).toContain("LLM extraction failed");
			expect(output).toContain("signet repair queue");
			expect(output).toContain("unhealthy composite health");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor flags the dead-job backlog as an error finding (ok becomes false)", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-dead-backlog-"));
		try {
			const jsonOut = await captureDoctorJson(deadBacklogDeps(root).getDaemonStatus);
			expect(jsonOut.ok).toBe(false);
			const deadFinding = jsonOut.findings.find((f) => f.code === "dead_jobs_backlog");
			expect(deadFinding).toBeDefined();
			expect(deadFinding?.level).toBe("error");
			expect(deadFinding?.message).toContain("11227");
			expect(deadFinding?.fix).toContain("signet repair queue requeue");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor flags unhealthy composite health even without a dead backlog", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-unhealthy-"));
		try {
			const jsonOut = await captureDoctorJson(deadBacklogDeps(root, true).getDaemonStatus);
			expect(jsonOut.ok).toBe(false);
			const unhealthy = jsonOut.findings.find((f) => f.code === "daemon_unhealthy");
			expect(unhealthy).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor stays ok for a running daemon with clean queues", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-clean-"));
		try {
			const workspace = join(root, "agents");
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "agent.yaml"), "version: 1\n");
			writeFileSync(join(workspace, "SOUL.md"), "soul\n");
			writeFileSync(join(workspace, "IDENTITY.md"), "identity\n");
			writeFileSync(join(workspace, "USER.md"), "user\n");
			writeFileSync(join(workspace, "MEMORY.md"), "memory\n");
			writeFileSync(join(workspace, "AGENTS.md"), "# agents\n");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "sqlite");
			process.env.HOME = root;

			const base = deadBacklogDeps(workspace);
			base.getDaemonStatus = async () => ({
				...(await deadBacklogDeps(workspace).getDaemonStatus()),
				health: { score: 0.99, status: "healthy" },
				queue: {
					memory: { ...queueFixture.memory, dead: 0, lastError: null },
					summary: { ...queueFixture.summary, dead: 0, lastError: null },
				},
			});
			const jsonOut = await captureDoctorJson(base.getDaemonStatus);
			expect(jsonOut.findings.some((f) => f.code === "dead_jobs_backlog")).toBe(false);
			expect(jsonOut.findings.some((f) => f.code === "daemon_unhealthy")).toBe(false);
		} finally {
			process.env.HOME = originalHome;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

async function captureDoctorJson(
	getDaemonStatus: () => Promise<Record<string, unknown>>,
): Promise<{ ok: boolean; findings: Array<{ code?: string; level: string; message: string; fix?: string }> }> {
	const lines: string[] = [];
	const oldLog = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.join(" "));
	};
	try {
		await showDoctor(
			{ json: true },
			{
				agentsDir: "/tmp/agents",
				defaultPort: 3850,
				detectExistingSetup: () => ({
					agentsDir: true,
					agentsMd: true,
					agentYaml: true,
					memoryDb: true,
				}),
				extractPathOption: () => null,
				formatUptime: () => "0s",
				getDaemonStatus,
				normalizeAgentPath: (pathValue: string) => pathValue,
				parseIntegerValue: (value: unknown) => (typeof value === "number" ? value : null),
				signetLogo: () => "signet",
			},
		);
	} finally {
		console.log = oldLog;
	}
	return JSON.parse(lines.join("")) as {
		ok: boolean;
		findings: Array<{ code?: string; level: string; message: string; fix?: string }>;
	};
}

describe("daemon lifecycle exit findings (#1148)", () => {
	function lifecycleDeps(root: string, lastExit: unknown) {
		return {
			...depsFor(root),
			getDaemonStatus: async () => ({
				running: false,
				pid: null,
				uptime: null,
				version: null,
				host: null,
				bindHost: null,
				networkMode: null,
				probe: {
					status: "absent",
					detail: "No Signet daemon process or healthy listener was found",
					url: "http://127.0.0.1:3850",
					listenerPresent: false,
					processPid: null,
					stalePid: null,
					lastExit,
				},
			}),
		};
	}

	it("doctor flags an unrecorded daemon death (SIGKILL/crash) with a pointer to the evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-lifecycle-"));
		try {
			const jsonOut = await captureDoctorJson(
				lifecycleDeps(root, {
					state: "running",
					pid: 4242,
					version: "0.165.0",
					startedAt: "2026-08-07T00:00:00.000Z",
					systemdUnit: "signet-daemon-1234",
				}).getDaemonStatus,
			);
			const finding = jsonOut.findings.find((f) => f.code === "daemon_exit_unrecorded");
			expect(finding).toBeDefined();
			expect(finding?.level).toBe("warn");
			expect(finding?.message).toContain("killed or crashed");
			expect(finding?.message).toContain("pid 4242");
			expect(finding?.message).toContain("No shutdown marker was written");
			expect(finding?.fix).toContain("journalctl --user -u signet-daemon-1234");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not report an unrecorded death while the recorded pid is alive (custom port / still booting)", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-lifecycle-"));
		try {
			// The daemon on a custom SIGNET_PORT is invisible to the fixed-port
			// probe, but the lifecycle record's pid is live — the finding must
			// not claim "killed or crashed" against a running process.
			const jsonOut = await captureDoctorJson(
				lifecycleDeps(root, {
					state: "running",
					pid: process.pid,
					version: "0.165.0",
					startedAt: "2026-08-07T00:00:00.000Z",
				}).getDaemonStatus,
			);
			const finding = jsonOut.findings.find((f) => f.code === "daemon_exit_unrecorded");
			expect(finding).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor reports a clean last exit as info, not an error", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-lifecycle-"));
		try {
			const jsonOut = await captureDoctorJson(
				lifecycleDeps(root, {
					state: "clean",
					pid: 7,
					version: "0.165.0",
					startedAt: "2026-08-07T00:00:00.000Z",
					reason: "signal:SIGTERM",
					exitCode: 0,
					exitedAt: "2026-08-07T01:00:00.000Z",
				}).getDaemonStatus,
			);
			const finding = jsonOut.findings.find((f) => f.code === "daemon_exit_clean");
			expect(finding).toBeDefined();
			expect(finding?.level).toBe("info");
			expect(finding?.message).toContain("signal:SIGTERM");
			expect(finding?.message).toContain("exit code 0");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("doctor reports an internal-error exit with the error message and fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "doctor-lifecycle-"));
		try {
			const jsonOut = await captureDoctorJson(
				lifecycleDeps(root, {
					state: "error",
					pid: 8,
					version: "0.165.0",
					startedAt: "2026-08-07T00:00:00.000Z",
					reason: "error:uncaughtException",
					exitCode: 1,
					exitedAt: "2026-08-07T00:00:30.000Z",
					error: "boom",
				}).getDaemonStatus,
			);
			expect(jsonOut.ok).toBe(false);
			const finding = jsonOut.findings.find((f) => f.code === "daemon_exit_error");
			expect(finding).toBeDefined();
			expect(finding?.level).toBe("error");
			expect(finding?.message).toContain("boom");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("doctor unknown target", () => {
	it("sets a non-zero exit code for an unsupported doctor target", async () => {
		const lines: string[] = [];
		const oldLog = console.log;
		const previousExitCode = process.exitCode;
		try {
			Reflect.deleteProperty(process, "exitCode");
			console.log = (...args: unknown[]) => {
				lines.push(args.join(" "));
			};

			await showDoctor({ target: "nonexistent-target" }, depsFor("/tmp/doctor-unknown-target"));

			expect(process.exitCode).toBe(1);
			expect(lines.join("\n")).toContain("Unknown doctor target: nonexistent-target");
			expect(lines.join("\n")).toContain("Supported targets: hermes");
		} finally {
			console.log = oldLog;
			if (previousExitCode === undefined) Reflect.deleteProperty(process, "exitCode");
			else process.exitCode = previousExitCode;
		}
	});
});
