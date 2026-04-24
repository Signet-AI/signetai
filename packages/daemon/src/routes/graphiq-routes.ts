import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	disableGraphiqState,
	enableGraphiqState,
	readGraphiqState,
	setGraphiqActiveProject,
	updateGraphiqActiveProject,
} from "@signet/core";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getActiveGraphiqDbPath, getAgentsDir, resolveGraphiqBinary, runCommand } from "../graphiq.js";
import { SIGNET_GRAPHIQ_PLUGIN_ID } from "../plugins/bundled/graphiq.js";
import { getDefaultPluginHost } from "../plugins/index.js";
import { authConfig } from "./state.js";

export function registerGraphiqRoutes(app: Hono): void {
	const adminGuard = async (c: import("hono").Context, next: import("hono").Next) => {
		return requirePermission("admin", authConfig)(c, next);
	};
	app.use("/api/graphiq/*", adminGuard);

	app.get("/api/graphiq/status", (c) => {
		const agentsDir = getAgentsDir();
		const state = readGraphiqState(agentsDir);
		const installed = isGraphiqInstalled();
		const active = getActiveGraphiqDbPath();
		const host = getDefaultPluginHost();
		const plugin = host.get(SIGNET_GRAPHIQ_PLUGIN_ID);

		const projects =
			state.indexedProjects.length > 0
				? state.indexedProjects.map((p) => ({
						path: p.path,
						lastIndexedAt: p.lastIndexedAt,
						files: p.files,
						symbols: p.symbols,
						edges: p.edges,
					}))
				: discoverGraphiqProjects(agentsDir);

		return c.json({
			installed,
			pluginEnabled: plugin?.enabled ?? false,
			pluginState: plugin?.state ?? "not-registered",
			activeProject: active?.activeProject ?? projects[0]?.path ?? null,
			indexedProjects: projects,
			installSource: state.installSource ?? null,
		});
	});

	app.post("/api/graphiq/install", async (c) => {
		if (isGraphiqInstalled()) {
			const agentsDir = getAgentsDir();
			enableGraphiqState(agentsDir, { installSource: "existing" });
			getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, true);
			return c.json({ success: true, message: "GraphIQ already installed, plugin enabled" });
		}

		const result = await installGraphiq();
		if (!result.success) {
			return c.json({ success: false, error: result.error }, 500);
		}

		const agentsDir = getAgentsDir();
		enableGraphiqState(agentsDir, { installSource: result.source });
		getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, true);
		return c.json({ success: true, message: `GraphIQ installed via ${result.source}`, source: result.source });
	});

	app.post("/api/graphiq/update", async (c) => {
		const result = await updateGraphiq();
		if (!result.success) {
			return c.json({ success: false, error: result.error }, 500);
		}
		return c.json({ success: true, message: result.message });
	});

	app.post("/api/graphiq/uninstall", async (c) => {
		const agentsDir = getAgentsDir();
		disableGraphiqState(agentsDir);
		getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, false);
		return c.json({ success: true, message: "GraphIQ plugin disabled" });
	});

	app.post("/api/graphiq/index", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const projectPath = body.path;
		if (typeof projectPath !== "string" || !projectPath.trim()) {
			return c.json({ success: false, error: "path is required" }, 400);
		}

		const resolved = resolve(projectPath);
		if (!existsSync(resolved)) {
			return c.json({ success: false, error: `Project path does not exist: ${resolved}` }, 400);
		}
		let projectStat: ReturnType<typeof statSync>;
		try {
			projectStat = statSync(resolved);
		} catch {
			return c.json({ success: false, error: `Project path is not accessible: ${resolved}` }, 400);
		}
		if (!projectStat.isDirectory()) {
			return c.json({ success: false, error: `Project path must be a directory: ${resolved}` }, 400);
		}
		try {
			accessSync(resolved, constants.R_OK | constants.X_OK);
		} catch {
			return c.json({ success: false, error: `Project path must be readable: ${resolved}` }, 400);
		}

		if (!isGraphiqInstalled()) {
			const installResult = await installGraphiq();
			if (!installResult.success) {
				return c.json({ success: false, error: `GraphIQ not installed: ${installResult.error}` }, 500);
			}
			enableGraphiqState(getAgentsDir(), { installSource: installResult.source });
			getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, true);
		}

		const agentsDir = getAgentsDir();
		try {
			const binary = resolveGraphiqBinary();
			if (!binary) {
				return c.json({ success: false, error: "GraphIQ binary not found after install" }, 500);
			}
			const dbDir = join(resolved, ".graphiq");
			const dbPath = join(dbDir, "graphiq.db");
			const result = await runCommand(binary, ["index", resolved, "--db", dbPath], 300_000);
			if (result.code !== 0) {
				const msg = result.stderr.trim() || result.stdout.trim() || `graphiq index exited with code ${result.code}`;
				return c.json({ success: false, error: msg }, 500);
			}
			const stats = parseIndexStats(result.stdout);
			updateGraphiqActiveProject(agentsDir, {
				projectPath: resolved,
				...stats,
			});
			getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, true);
			return c.json({ success: true, project: resolved, stats });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ success: false, error: message }, 500);
		}
	});
}

function isGraphiqInstalled(): boolean {
	return resolveGraphiqBinary() !== null;
}

function getInstallScriptPath(): string {
	const thisDir = dirname(fileURLToPath(import.meta.url));
	return resolve(thisDir, "../../../../scripts/install-graphiq.sh");
}

async function installGraphiq(): Promise<{ success: boolean; source?: string; error?: string }> {
	const script = getInstallScriptPath();
	if (!existsSync(script)) {
		return { success: false, error: `Install script not found: ${script}` };
	}

	try {
		const result = await runCommand("bash", [script, "install"], 120_000, { GRAPHIQ_ALLOW_LATEST: "1" });
		if (result.code === 0 && isGraphiqInstalled()) {
			return { success: true, source: "script" };
		}
		const detail = result.stderr.trim() || result.stdout.trim() || `install script exited with code ${result.code}`;
		return { success: false, error: detail };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function updateGraphiq(): Promise<{ success: boolean; message?: string; error?: string }> {
	const script = getInstallScriptPath();
	if (!existsSync(script)) {
		return { success: false, error: `Install script not found: ${script}` };
	}

	try {
		const result = await runCommand("bash", [script, "update"], 120_000, { GRAPHIQ_ALLOW_LATEST: "1" });
		if (result.code === 0) {
			return { success: true, message: "GraphIQ updated via script" };
		}
		return { success: false, error: result.stderr.trim() || result.stdout.trim() || "update script failed" };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function parseIndexStats(output: string): { files?: number; symbols?: number; edges?: number } {
	const match = output.match(/Files:\s+(\d+)\s+Symbols:\s+(\d+).*?Edges:\s+(\d+)/s);
	if (!match) return {};
	return {
		files: Number.parseInt(match[1] ?? "", 10),
		symbols: Number.parseInt(match[2] ?? "", 10),
		edges: Number.parseInt(match[3] ?? "", 10),
	};
}

function discoverGraphiqProjects(
	agentsDir: string,
): readonly { path: string; lastIndexedAt: string; files?: number; symbols?: number; edges?: number }[] {
	const candidates = [agentsDir, join(agentsDir, "..")];
	const results: { path: string; lastIndexedAt: string; files?: number; symbols?: number; edges?: number }[] = [];
	for (const dir of candidates) {
		const manifestPath = join(dir, ".graphiq", "manifest.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
			if (typeof raw !== "object" || raw === null) continue;
			const indexedAt =
				typeof raw.indexed_at === "string" ? new Date(Number(raw.indexed_at) * 1000).toISOString() : undefined;
			results.push({
				path: resolve(dir),
				lastIndexedAt: indexedAt ?? new Date().toISOString(),
				files: typeof raw.files === "number" ? raw.files : undefined,
				symbols: typeof raw.symbols === "number" ? raw.symbols : undefined,
				edges: typeof raw.edges === "number" ? raw.edges : undefined,
			});
		} catch {
			// skip unparseable entries
		}
	}
	return results;
}

export function autoConnectGraphiq(projectPath: string | undefined): void {
	if (!projectPath) return;
	const resolved = resolve(projectPath);
	const agentsDir = getAgentsDir();
	const state = readGraphiqState(agentsDir);
	if (!state.enabled) return;
	if (state.activeProject === resolved) return;
	const known = state.indexedProjects.some((p) => p.path === resolved);
	if (!known) return;

	setGraphiqActiveProject(agentsDir, resolved);
}
