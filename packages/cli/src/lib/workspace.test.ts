import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceConfigPath, resolveAgentsDir, writeConfiguredWorkspacePath } from "./workspace.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("workspace path resolution", () => {
	it("prefers SIGNET_PATH over stored config", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-env-"));
		const env = {
			...process.env,
			XDG_CONFIG_HOME: root,
			SIGNET_PATH: join(root, "from-env"),
		};
		writeConfiguredWorkspacePath(join(root, "from-config"), env);

		const resolved = resolveAgentsDir(env);
		expect(resolved.path).toBe(join(root, "from-env"));
		expect(resolved.source).toBe("env");
	});

	it("uses stored config when env override is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-config-"));
		const env = {
			...process.env,
			XDG_CONFIG_HOME: root,
			SIGNET_PATH: "",
		};
		writeConfiguredWorkspacePath(join(root, "agent-home"), env);

		const resolved = resolveAgentsDir(env);
		expect(resolved.path).toBe(join(root, "agent-home"));
		expect(resolved.source).toBe("config");
	});

	it("falls back to ~/.agents when no env or config is present", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-default-"));
		const env = {
			...process.env,
			XDG_CONFIG_HOME: root,
			SIGNET_PATH: "",
		};

		const resolved = resolveAgentsDir(env);
		expect(resolved.source).toBe("default");
		expect(resolved.path.endsWith(join(".agents"))).toBe(true);
	});

	it("writes workspace config payload to expected file", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-write-"));
		const env = {
			...process.env,
			XDG_CONFIG_HOME: root,
		};
		const target = join(root, "target-workspace");
		const cfgPath = writeConfiguredWorkspacePath(target, env);
		const expected = getWorkspaceConfigPath(env);
		expect(cfgPath).toBe(expected);

		const raw: unknown = JSON.parse(readFileSync(cfgPath, "utf-8"));
		if (!isRecord(raw)) {
			throw new Error("config payload is not an object");
		}
		if (!("workspace" in raw) || !("version" in raw)) {
			throw new Error("config payload missing workspace/version");
		}
		expect(raw.workspace).toBe(target);
		expect(raw.version).toBe(1);
	});
});
