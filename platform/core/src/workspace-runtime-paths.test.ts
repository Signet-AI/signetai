import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGraphiqStatePath, readGraphiqState, updateGraphiqActiveProject } from "./graphiq";
import { getPluginRegistryDir, getPluginRegistryPath } from "./plugins";
import { findExistingWorkspaceDatabase, hasExistingWorkspaceState } from "./workspace-layout";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(version?: 1 | 2): string {
	const root = mkdtempSync(join(tmpdir(), "signet-runtime-paths-"));
	roots.push(root);
	if (version) writeFileSync(join(root, "workspace-layout.json"), `${JSON.stringify({ version })}\n`);
	return root;
}

describe("workspace runtime state paths", () => {
	it("keeps the plugin registry and GraphIQ state under .daemon on v1 workspaces", () => {
		const root = workspace();
		expect(getPluginRegistryDir(root)).toBe(join(root, ".daemon", "plugins"));
		expect(getPluginRegistryPath(root)).toBe(join(root, ".daemon", "plugins", "registry-v1.json"));
		expect(getGraphiqStatePath(root)).toBe(join(root, ".daemon", "graphiq", "state.json"));
	});

	it("puts the plugin registry and GraphIQ state under runtime/ on v2 workspaces", () => {
		const root = workspace(2);
		const project = join(root, "project");
		mkdirSync(project);
		expect(getPluginRegistryPath(root)).toBe(join(root, "runtime", "plugins", "registry-v1.json"));
		expect(getGraphiqStatePath(root)).toBe(join(root, "runtime", "graphiq", "state.json"));

		updateGraphiqActiveProject(root, { projectPath: project, indexedAt: new Date("2026-01-01T00:00:00.000Z") });

		expect(existsSync(join(root, "runtime", "graphiq", "state.json"))).toBe(true);
		expect(existsSync(join(root, ".daemon"))).toBe(false);
		expect(readGraphiqState(root).activeProject).toBe(project);
	});
});

describe("existing workspace state detection", () => {
	it("treats an empty root as having no Signet state", () => {
		const root = workspace();
		expect(findExistingWorkspaceDatabase(root)).toBeNull();
		expect(hasExistingWorkspaceState(root)).toBe(false);
	});

	it("detects a v1 database and v1 runtime state", () => {
		const withDb = workspace();
		mkdirSync(join(withDb, "memory"));
		writeFileSync(join(withDb, "memory", "memories.db"), "");
		expect(findExistingWorkspaceDatabase(withDb)).toBe(join(withDb, "memory", "memories.db"));
		expect(hasExistingWorkspaceState(withDb)).toBe(true);

		const withRuntime = workspace();
		mkdirSync(join(withRuntime, ".daemon"));
		expect(findExistingWorkspaceDatabase(withRuntime)).toBeNull();
		expect(hasExistingWorkspaceState(withRuntime)).toBe(true);
	});

	it("detects a v2 database", () => {
		const root = workspace(2);
		mkdirSync(join(root, "data"));
		writeFileSync(join(root, "data", "signet.db"), "");
		expect(findExistingWorkspaceDatabase(root)).toBe(join(root, "data", "signet.db"));
		expect(hasExistingWorkspaceState(root)).toBe(true);
	});
});
