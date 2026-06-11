import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawConnector } from "@signetai/connector-openclaw";
import { syncBuiltinSkills, syncTemplates } from "./sync.js";

const originalHome = process.env.HOME;
const originalOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;
const originalClawdbotConfig = process.env.CLAWDBOT_CONFIG_PATH;

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

	if (originalClawdbotConfig === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
		delete process.env.CLAWDBOT_CONFIG_PATH;
	} else {
		process.env.CLAWDBOT_CONFIG_PATH = originalClawdbotConfig;
	}
});

describe("syncTemplates workspace detection", () => {
	it("succeeds when agentsDir is a valid directory (regression: #515-related wiring)", async () => {
		const root = mkdtempSync(join(tmpdir(), "sync-workspace-"));
		const basePath = join(root, "agents");
		const origLog = console.log;

		try {
			process.env.HOME = root;
			mkdirSync(basePath, { recursive: true });
			const logs: string[] = [];
			console.log = (...args: unknown[]) => logs.push(args.join(" "));

			await syncTemplates({
				agentsDir: basePath,
				configureHarnessHooks: mock(async () => {}),
				getSkillsSourceDir: () => join(root, "skills-src"),
				getTemplatesDir: () => join(root, "templates"),
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async () => ({
					status: "current",
					path: join(basePath, "signetai"),
					message: "current",
					branch: "main",
					defaultBranch: "main",
				}),
			});

			const output = logs.join("\n");
			expect(output).not.toContain("No Signet installation found");
		} finally {
			console.log = origLog;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports missing installation when agentsDir does not exist", async () => {
		const logs: string[] = [];
		const origLog = console.log;

		try {
			console.log = (...args: unknown[]) => logs.push(args.join(" "));

			await syncTemplates({
				agentsDir: `/tmp/signet-nonexistent-${Date.now()}`,
				configureHarnessHooks: mock(async () => {}),
				getSkillsSourceDir: () => "/tmp",
				getTemplatesDir: () => "/tmp",
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async () => ({
					status: "current",
					path: "/tmp",
					message: "current",
					branch: "main",
					defaultBranch: "main",
				}),
			});

			const output = logs.join("\n");
			expect(output).toContain("No Signet installation found");
		} finally {
			console.log = origLog;
		}
	});

	it("only re-registers hooks for harnesses configured in agent.yaml", async () => {
		const root = mkdtempSync(join(tmpdir(), "sync-active-harnesses-"));
		const basePath = join(root, "agents");
		const origLog = console.log;

		try {
			process.env.HOME = root;
			mkdirSync(basePath, { recursive: true });
			mkdirSync(join(root, ".codex"), { recursive: true });
			mkdirSync(join(root, ".config", "opencode"), { recursive: true });
			writeFileSync(join(root, ".codex", "config.toml"), "[model]\n");
			writeFileSync(join(basePath, "agent.yaml"), "harnesses:\n  - pi\n");

			const logs: string[] = [];
			console.log = (...args: unknown[]) => logs.push(args.join(" "));
			const configureHarnessHooks = mock(async () => {});

			await syncTemplates({
				agentsDir: basePath,
				configureHarnessHooks,
				getSkillsSourceDir: () => join(root, "skills-src"),
				getTemplatesDir: () => join(root, "templates"),
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async () => ({
					status: "current",
					path: join(basePath, "signetai"),
					message: "current",
					branch: "main",
					defaultBranch: "main",
				}),
			});

			expect(configureHarnessHooks.mock.calls.map((call) => call[0])).toEqual(["pi"]);
			const output = logs.join("\n");
			expect(output).toContain("Installed harnesses detected:");
			expect(output).toContain("codex");
			expect(output).toContain("opencode");
			expect(output).toContain("Installed but inactive:");
			expect(output).not.toContain("hooks re-registered for codex");
			expect(output).not.toContain("hooks re-registered for opencode");
		} finally {
			console.log = origLog;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("syncBuiltinSkills", () => {
	it("refreshes an existing skill when the source is now a built-in", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-builtin-skills-"));
		const source = join(root, "source");
		const basePath = join(root, "agents");

		try {
			mkdirSync(join(source, "dreaming"), { recursive: true });
			mkdirSync(join(basePath, "skills", "dreaming"), { recursive: true });
			writeFileSync(
				join(source, "dreaming", "SKILL.md"),
				"---\nname: dreaming\ndescription: Dreaming\nbuiltin: true\n---\n\n# Dreaming\n\ncurrent",
			);
			writeFileSync(
				join(basePath, "skills", "dreaming", "SKILL.md"),
				"---\nname: dreaming\ndescription: Dreaming\n---\n\n# Dreaming\n\nstale",
			);

			const result = syncBuiltinSkills(source, basePath);

			expect(result).toEqual({ installed: [], updated: ["dreaming"], skipped: [] });
			expect(readFileSync(join(basePath, "skills", "dreaming", "SKILL.md"), "utf-8")).toContain("current");
			expect(readFileSync(join(basePath, "skills", "dreaming", "SKILL.md"), "utf-8")).toContain("builtin: true");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not overwrite user-owned skills when the source is not a built-in", () => {
		const root = mkdtempSync(join(tmpdir(), "sync-user-skills-"));
		const source = join(root, "source");
		const basePath = join(root, "agents");

		try {
			mkdirSync(join(source, "custom"), { recursive: true });
			mkdirSync(join(basePath, "skills", "custom"), { recursive: true });
			writeFileSync(join(source, "custom", "SKILL.md"), "---\nname: custom\ndescription: Official\n---\n\nsource");
			writeFileSync(
				join(basePath, "skills", "custom", "SKILL.md"),
				"---\nname: custom\ndescription: User\n---\n\nuser",
			);

			const result = syncBuiltinSkills(source, basePath);

			expect(result).toEqual({ installed: [], updated: [], skipped: ["custom"] });
			expect(readFileSync(join(basePath, "skills", "custom", "SKILL.md"), "utf-8")).toContain("user");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("syncTemplates openclaw migration", () => {
	it("migrates legacy-only openclaw configs to the plugin path during sync", async () => {
		const root = mkdtempSync(join(tmpdir(), "sync-openclaw-"));
		const basePath = join(root, "agents");
		const configPath = join(root, "openclaw.json");

		try {
			process.env.HOME = root;
			process.env.OPENCLAW_CONFIG_PATH = configPath;
			mkdirSync(basePath, { recursive: true });
			writeFileSync(join(basePath, "agent.yaml"), "harnesses:\n  - openclaw\n");

			writeFileSync(
				configPath,
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

			const configureHarnessHooks = mock(
				async (
					harness: string,
					path: string,
					options?: {
						openclawRuntimePath?: "plugin" | "legacy";
					},
				) => {
					if (harness !== "openclaw") {
						return;
					}

					await new OpenClawConnector().install(path, {
						configureWorkspace: false,
						runtimePath: options?.openclawRuntimePath,
					});
				},
			);

			await syncTemplates({
				agentsDir: basePath,
				configureHarnessHooks,
				getSkillsSourceDir: () => join(root, "skills-src"),
				getTemplatesDir: () => join(root, "templates"),
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async () => ({
					status: "current",
					path: join(basePath, "signetai"),
					message: "Signet source checkout is already current",
					branch: "main",
					defaultBranch: "main",
				}),
			});

			expect(configureHarnessHooks).toHaveBeenCalledWith("openclaw", basePath, {
				openclawRuntimePath: "plugin",
			});

			const patched = JSON.parse(readFileSync(configPath, "utf-8")) as {
				hooks?: { internal?: { entries?: Record<string, { enabled?: boolean }> } };
				plugins?: {
					slots?: { memory?: string };
					entries?: Record<string, { enabled?: boolean }>;
				};
			};
			expect(patched.hooks?.internal?.entries?.["signet-memory"]?.enabled).toBe(false);
			expect(patched.plugins?.slots?.memory).toBe("signet-memory-openclaw");
			expect(patched.plugins?.entries?.["signet-memory-openclaw"]?.enabled).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves dual-runtime openclaw configs on the discovered path during sync", async () => {
		const root = mkdtempSync(join(tmpdir(), "sync-openclaw-dual-"));
		const basePath = join(root, "agents");
		const openClawConfigPath = join(root, "openclaw.json");
		const clawdbotConfigPath = join(root, "clawdbot.json");

		try {
			process.env.HOME = root;
			process.env.OPENCLAW_CONFIG_PATH = openClawConfigPath;
			process.env.CLAWDBOT_CONFIG_PATH = clawdbotConfigPath;
			mkdirSync(basePath, { recursive: true });
			writeFileSync(join(basePath, "agent.yaml"), "harnesses:\n  - openclaw\n");

			writeFileSync(
				openClawConfigPath,
				JSON.stringify({
					plugins: {
						slots: { memory: "signet-memory-openclaw" },
						entries: {
							"signet-memory-openclaw": { enabled: true },
						},
					},
				}),
			);
			writeFileSync(
				clawdbotConfigPath,
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

			const configureHarnessHooks = mock(async () => {});

			await syncTemplates({
				agentsDir: basePath,
				configureHarnessHooks,
				getSkillsSourceDir: () => join(root, "skills-src"),
				getTemplatesDir: () => join(root, "templates"),
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async () => ({
					status: "current",
					path: join(basePath, "signetai"),
					message: "Signet source checkout is already current",
					branch: "main",
					defaultBranch: "main",
				}),
			});

			expect(configureHarnessHooks).toHaveBeenCalledWith("openclaw", basePath, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("awaits async source checkout sync during template sync", async () => {
		const root = mkdtempSync(join(tmpdir(), "sync-source-repo-"));
		const basePath = join(root, "agents");

		try {
			process.env.HOME = root;
			mkdirSync(basePath, { recursive: true });
			const calls: string[] = [];

			await syncTemplates({
				agentsDir: basePath,
				configureHarnessHooks: mock(async () => {}),
				getSkillsSourceDir: () => join(root, "skills-src"),
				getTemplatesDir: () => join(root, "templates"),
				signetLogo: () => "signet",
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
				syncWorkspaceSourceRepo: async (path) => {
					calls.push(path);
					return {
						status: "current",
						path: join(path, "signetai"),
						message: "Signet source checkout is already current",
						branch: "main",
						defaultBranch: "main",
					};
				},
			});

			expect(calls).toEqual([basePath]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
