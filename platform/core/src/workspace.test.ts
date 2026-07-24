import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type WorkspaceResolution,
	clearConfiguredWorkspacePath,
	getWorkspaceConfigPath,
	normalizeWorkspacePath,
	readConfiguredWorkspacePath,
	resolveWorkspacePath,
	writeConfiguredWorkspacePath,
} from "./workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		// Strip host env so precedence tests are deterministic.
		SIGNET_PATH: undefined,
		SIGNET_WORKSPACE: undefined,
		XDG_CONFIG_HOME: undefined,
		...overrides,
	};
}

describe("normalizeWorkspacePath", () => {
	it("trims, expands ~, and resolves the path", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-norm-"));
		try {
			expect(normalizeWorkspacePath("  ~/x  ", home)).toBe(join(home, "x"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath precedence", () => {
	it("prefers SIGNET_PATH over stored config and SIGNET_WORKSPACE", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-env-"));
		try {
			const configHome = join(home, "config");
			const fromEnv = join(home, "env");
			const fromWorkspaceAlias = join(home, "env-alias");
			const fromConfig = join(home, "configured");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(
				join(configHome, "signet", "workspace.json"),
				JSON.stringify({ version: 1, workspace: fromConfig }),
			);

			const resolved = resolveWorkspacePath({
				env: makeEnv({ SIGNET_PATH: fromEnv, SIGNET_WORKSPACE: fromWorkspaceAlias, XDG_CONFIG_HOME: configHome }),
				home,
			});

			expect(resolved.path).toBe(fromEnv);
			expect(resolved.source).toBe("env");
			expect(resolved.configuredPath).toBe(fromConfig);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back to SIGNET_WORKSPACE when SIGNET_PATH is absent", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-alias-"));
		try {
			const workspace = join(home, "env-alias");
			const resolved = resolveWorkspacePath({ env: makeEnv({ SIGNET_WORKSPACE: workspace }), home });

			expect(resolved.path).toBe(workspace);
			expect(resolved.source).toBe("env");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("uses persisted config when no env override is present", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-config-"));
		try {
			const configHome = join(home, "config");
			const configured = join(home, "configured");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(
				join(configHome, "signet", "workspace.json"),
				JSON.stringify({ version: 1, workspace: configured }),
			);

			const resolved = resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home });

			expect(resolved.path).toBe(configured);
			expect(resolved.source).toBe("config");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back to ~/.agents when nothing is configured", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-default-"));
		try {
			const resolved = resolveWorkspacePath({ env: makeEnv(), home });

			expect(resolved.path).toBe(join(home, ".agents"));
			expect(resolved.source).toBe("default");
			expect(resolved.configuredPath).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath malformed config", () => {
	it("falls back gracefully by default", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-lenient-"));
		try {
			const configHome = join(home, "config");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), "{not json");

			const resolved = resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home });

			expect(resolved.source).toBe("default");
			expect(resolved.path).toBe(join(home, ".agents"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws in strict mode on malformed JSON", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-strict-"));
		try {
			const configHome = join(home, "config");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), "{not json");

			expect(() => resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home, strict: true })).toThrow(
				"Invalid Signet workspace config",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws in strict mode when workspace is missing or blank", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-strict-missing-"));
		try {
			const configHome = join(home, "config");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), JSON.stringify({ version: 1, workspace: "  " }));

			expect(() => resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home, strict: true })).toThrow(
				"workspace must be a non-empty string",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("a valid env override masks a malformed config even in strict mode", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-strict-masked-"));
		try {
			const configHome = join(home, "config");
			const envWorkspace = join(home, "env-wins");
			mkdirSync(envWorkspace, { recursive: true });
			mkdirSync(join(configHome, "signet"), { recursive: true });
			// Corrupt config that WOULD throw in strict mode if reached.
			writeFileSync(join(configHome, "signet", "workspace.json"), "{not json");

			// A valid env override short-circuits the malformed config instead of
			// throwing — preserving the historical contract that a connector install
			// with a valid SIGNET_PATH succeeds even when workspace.json is corrupt.
			const resolved = resolveWorkspacePath({
				env: makeEnv({ SIGNET_PATH: envWorkspace, XDG_CONFIG_HOME: configHome }),
				home,
				strict: true,
			});
			expect(resolved.source).toBe("env");
			expect(resolved.path).toBe(envWorkspace);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath requireExistingEnvPath", () => {
	it("trusts a non-existing env path by default", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-trust-"));
		try {
			const resolved = resolveWorkspacePath({ env: makeEnv({ SIGNET_PATH: "/nonexistent/stale/.agents" }), home });
			expect(resolved.source).toBe("env");
			expect(resolved.path).toBe("/nonexistent/stale/.agents");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("drops a stale env path and warns when requireExistingEnvPath is set (#1016)", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-stale-"));
		try {
			const warnings: string[] = [];
			const originalWarn = console.warn;
			console.warn = (message?: unknown) => warnings.push(String(message));
			try {
				const resolved = resolveWorkspacePath({
					env: makeEnv({ SIGNET_PATH: "/nonexistent/stale/.agents" }),
					home,
					requireExistingEnvPath: true,
				});
				expect(resolved.source).toBe("default");
				expect(resolved.path).toBe(join(home, ".agents"));
			} finally {
				console.warn = originalWarn;
			}
			expect(warnings.join("\n")).toContain("does not point to an existing workspace directory");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("accepts an existing env path when requireExistingEnvPath is set", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-existing-"));
		try {
			const existing = join(home, "real-workspace");
			mkdirSync(existing, { recursive: true });
			const resolved = resolveWorkspacePath({
				env: makeEnv({ SIGNET_PATH: existing }),
				home,
				requireExistingEnvPath: true,
			});
			expect(resolved.source).toBe("env");
			expect(resolved.path).toBe(existing);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("workspace config read/write/clear", () => {
	it("writes, reads, and clears the persisted workspace payload", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-io-"));
		try {
			const env = makeEnv({ XDG_CONFIG_HOME: join(home, "config") });
			const target = join(home, "target-workspace");
			const cfgPath = writeConfiguredWorkspacePath(target, env, home);
			expect(cfgPath).toBe(getWorkspaceConfigPath(env, home));
			expect(readConfiguredWorkspacePath(env, home)).toBe(target);

			const raw: unknown = JSON.parse(readFileSync(cfgPath, "utf-8"));
			if (!isRecord(raw) || !("workspace" in raw) || !("version" in raw)) throw new Error("bad payload");
			expect(raw.workspace).toBe(target);
			expect(raw.version).toBe(1);

			clearConfiguredWorkspacePath(env);
			expect(readConfiguredWorkspacePath(env, home)).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("readConfiguredWorkspacePath is null when config is absent", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-absent-"));
		try {
			expect(readConfiguredWorkspacePath(makeEnv({ XDG_CONFIG_HOME: join(home, "config") }), home)).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath respects the real host default", () => {
	it("uses process.env and homedir() when no options are given", () => {
		const resolved: WorkspaceResolution = resolveWorkspacePath({ env: makeEnv() });
		expect(resolved.path).toBe(join(homedir(), ".agents"));
		expect(resolved.source).toBe("default");
	});
});
