import { describe, expect, it } from "bun:test";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type WorkspaceFileSystem,
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
	it("throws instead of falling back when an existing config is malformed", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-malformed-"));
		try {
			const configHome = join(home, "config");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), "{not json");

			expect(() => resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home })).toThrow(
				"Invalid Signet workspace config",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("throws when an existing config is missing a workspace", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-missing-workspace-"));
		try {
			const configHome = join(home, "config");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), JSON.stringify({ version: 1 }));

			expect(() => resolveWorkspacePath({ env: makeEnv({ XDG_CONFIG_HOME: configHome }), home })).toThrow(
				"workspace config at",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not let an env override hide an existing malformed config", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-malformed-env-"));
		try {
			const configHome = join(home, "config");
			const envWorkspace = join(home, "env-wins");
			mkdirSync(envWorkspace, { recursive: true });
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), "{not json");

			expect(() =>
				resolveWorkspacePath({
					env: makeEnv({ SIGNET_PATH: envWorkspace, XDG_CONFIG_HOME: configHome }),
					home,
				}),
			).toThrow("Invalid Signet workspace config");
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

	it("keeps the existing pointer when an injected temp write is partial (#1472)", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-core-ws-atomic-"));
		try {
			const env = makeEnv({ XDG_CONFIG_HOME: join(home, "config") });
			const existingWorkspace = join(home, "existing-workspace");
			const replacementWorkspace = join(home, "replacement-workspace");
			const configPath = writeConfiguredWorkspacePath(existingWorkspace, env, home);
			const realFileSystem: WorkspaceFileSystem = {
				closeSync,
				fsyncSync,
				openSync,
				renameSync,
				rmSync,
				writeSync,
			};
			let injected = false;
			const failingFileSystem: WorkspaceFileSystem = {
				...realFileSystem,
				writeSync: (descriptor, buffer, offset, length) => {
					if (!injected) {
						injected = true;
						realFileSystem.writeSync(descriptor, buffer, offset, Math.max(1, Math.floor(length / 2)));
						throw new Error("injected partial workspace write");
					}
					return realFileSystem.writeSync(descriptor, buffer, offset, length);
				},
			};

			expect(() => writeConfiguredWorkspacePath(replacementWorkspace, env, home, failingFileSystem)).toThrow(
				"injected partial workspace write",
			);
			expect(readConfiguredWorkspacePath(env, home)).toBe(existingWorkspace);
			expect(resolveWorkspacePath({ env, home }).path).toBe(existingWorkspace);
			expect(readFileSync(configPath, "utf8")).toContain(existingWorkspace);
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
