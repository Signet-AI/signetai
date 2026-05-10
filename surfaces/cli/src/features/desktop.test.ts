import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDesktopFromSource,
	installDesktopFromSource,
	installLinuxDesktopApp,
	resolveDesktopSourceCheckout,
} from "./desktop.js";

function makeCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-desktop-test-"));
	mkdirSync(join(root, "surfaces", "desktop", "icons"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "signet", workspaces: ["platform/*", "surfaces/*"] }),
	);
	writeFileSync(
		join(root, "surfaces", "desktop", "package.json"),
		JSON.stringify({ name: "@signet/desktop", main: "dist/main.js", build: { appId: "ai.signet.app" } }),
	);
	writeFileSync(join(root, "surfaces", "desktop", "icons", "icon.png"), "icon");
	return root;
}

describe("desktop source checkout resolution", () => {
	test("finds an ancestor checkout from cwd", () => {
		const root = makeCheckout();
		try {
			const cwd = join(root, "surfaces", "desktop");
			expect(
				resolveDesktopSourceCheckout(undefined, {
					cwd,
					env: { SIGNET_PATH: join(root, "missing-workspace") },
				}),
			).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("finds the checkout under the configured workspace", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const workspace = join(home, "workspace");
		const checkout = makeCheckout();
		const repo = join(workspace, "signetai");
		const outside = join(home, "outside");
		try {
			mkdirSync(workspace, { recursive: true });
			mkdirSync(outside, { recursive: true });
			rmSync(repo, { recursive: true, force: true });
			mkdirSync(repo, { recursive: true });
			for (const entry of ["package.json", "surfaces"]) {
				renameSync(join(checkout, entry), join(repo, entry));
			}

			expect(resolveDesktopSourceCheckout(undefined, { cwd: outside, env: { SIGNET_PATH: workspace } })).toBe(repo);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("finds the checkout under the workspace config path", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const configHome = join(home, "config");
		const workspace = join(home, "configured-workspace");
		const repo = join(workspace, "signetai");
		const checkout = makeCheckout();
		const outside = join(home, "outside");
		try {
			mkdirSync(join(configHome, "signet"), { recursive: true });
			mkdirSync(workspace, { recursive: true });
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(configHome, "signet", "workspace.json"), JSON.stringify({ version: 1, workspace }));
			mkdirSync(repo, { recursive: true });
			for (const entry of ["package.json", "surfaces"]) {
				renameSync(join(checkout, entry), join(repo, entry));
			}

			expect(resolveDesktopSourceCheckout(undefined, { cwd: outside, env: { XDG_CONFIG_HOME: configHome } })).toBe(
				repo,
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("honors SIGNET_SOURCE_DIR before the configured workspace", () => {
		const explicit = makeCheckout();
		const workspaceRepo = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const workspace = join(home, "workspace");
		try {
			mkdirSync(workspace, { recursive: true });
			rmSync(join(workspace, "signetai"), { recursive: true, force: true });
			renameSync(workspaceRepo, join(workspace, "signetai"));
			expect(
				resolveDesktopSourceCheckout(undefined, {
					cwd: home,
					env: { SIGNET_PATH: workspace, SIGNET_SOURCE_DIR: explicit },
				}),
			).toBe(explicit);
		} finally {
			rmSync(explicit, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("rejects explicit non-checkout paths", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-desktop-missing-"));
		try {
			expect(() => resolveDesktopSourceCheckout(root, { env: {} })).toThrow("Not a Signet source checkout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("rejects lookalike checkouts before running source commands", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-desktop-lookalike-"));
		try {
			mkdirSync(join(root, "surfaces", "desktop"), { recursive: true });
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: "signet", workspaces: ["platform/*", "surfaces/*"] }),
			);
			writeFileSync(
				join(root, "surfaces", "desktop", "package.json"),
				JSON.stringify({ name: "@signet/desktop", main: "dist/main.js", build: { appId: "wrong.app" } }),
			);

			expect(() => resolveDesktopSourceCheckout(root, { env: {} })).toThrow("Not a Signet source checkout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("desktop source build", () => {
	test("syncs the managed workspace checkout before building by default", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const workspace = join(home, "workspace");
		const calls: string[] = [];
		try {
			mkdirSync(workspace, { recursive: true });
			const result = buildDesktopFromSource(
				{},
				{
					cwd: home,
					env: { SIGNET_PATH: workspace },
					syncWorkspaceSourceRepo: (workspaceDir) => {
						calls.push(`sync ${workspaceDir}`);
						return {
							status: "pulled",
							path: root,
							message: "pulled latest Signet source checkout",
							branch: "main",
							defaultBranch: "main",
						};
					},
					runner: (cmd, args, opts) => {
						calls.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`);
						return { status: 0 };
					},
				},
			);

			expect(result.repo).toBe(root);
			expect(calls).toEqual([`sync ${workspace}`, `bun install @ ${root}`, `bun run build:desktop @ ${root}`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("runs dependency install before desktop build", () => {
		const root = makeCheckout();
		const calls: string[] = [];
		try {
			const result = buildDesktopFromSource(
				{ repo: root },
				{
					runner: (cmd, args, opts) => {
						calls.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`);
						return { status: 0 };
					},
				},
			);

			expect(result.releaseDir).toBe(join(root, "surfaces", "desktop", "release"));
			expect(calls).toEqual([`bun install @ ${root}`, `bun run build:desktop @ ${root}`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("linux desktop install", () => {
	test("installs the newest matching AppImage as a user launcher", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(join(release, "nested"), { recursive: true });
			const oldArtifact = join(release, "Signet-0.1.0-linux-x86_64.AppImage");
			const newArtifact = join(release, "Signet-0.2.0-linux-x86_64.AppImage");
			const wrongArchArtifact = join(release, "Signet-0.3.0-linux-arm64.AppImage");
			const nestedArtifact = join(release, "nested", "Signet-0.4.0-linux-x86_64.AppImage");
			writeFileSync(oldArtifact, "old");
			writeFileSync(newArtifact, "new");
			writeFileSync(wrongArchArtifact, "wrong-arch");
			writeFileSync(nestedArtifact, "nested");
			utimesSync(oldArtifact, new Date(1_000), new Date(1_000));
			utimesSync(newArtifact, new Date(2_000), new Date(2_000));
			utimesSync(wrongArchArtifact, new Date(3_000), new Date(3_000));
			utimesSync(nestedArtifact, new Date(4_000), new Date(4_000));

			const workspace = join(home, "workspace");
			const result = installLinuxDesktopApp(root, home, workspace);

			expect(readFileSync(result.appImage, "utf8")).toBe("new");
			expect(lstatSync(result.binary).isSymbolicLink()).toBe(false);
			const launcher = readFileSync(result.binary, "utf8");
			expect(launcher).toContain("# signet-desktop managed launcher");
			expect(launcher).toContain(`export SIGNET_PATH='${workspace}'`);
			expect(launcher).toContain(`exec '${result.appImage}' "$@"`);
			expect(readFileSync(result.desktopEntry, "utf8")).toContain("Name=Signet");
			expect(readFileSync(result.desktopEntry, "utf8")).toContain(`Exec=\"${result.binary}\" %U`);
			expect(existsSync(result.icon)).toBe(true);
			expect(result.workspace).toBe(workspace);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("does not overwrite an existing non-symlink launcher", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "app");
			const binDir = join(home, ".local", "bin");
			mkdirSync(binDir, { recursive: true });
			const existing = join(binDir, "signet-desktop");
			writeFileSync(existing, "custom launcher");

			expect(() => installLinuxDesktopApp(root, home, join(home, "workspace"))).toThrow(
				"Refusing to replace existing non-managed launcher",
			);
			expect(readFileSync(existing, "utf8")).toBe("custom launcher");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("replaces an existing read-only AppImage through a staged swap", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "new app");
			const appDir = join(home, ".local", "share", "signet", "desktop");
			mkdirSync(appDir, { recursive: true });
			const existing = join(appDir, "Signet.AppImage");
			writeFileSync(existing, "old app");
			chmodSync(existing, 0o555);

			const result = installLinuxDesktopApp(root, home, join(home, "workspace"));

			expect(readFileSync(result.appImage, "utf8")).toBe("new app");
			expect(lstatSync(result.appImage).mode & 0o777).toBe(0o755);
			expect(readdirSync(appDir).some((name) => name.startsWith(".Signet.AppImage."))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("replaces an existing Signet-owned launcher symlink", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "app");
			const appDir = join(home, ".local", "share", "signet", "desktop");
			const binDir = join(home, ".local", "bin");
			mkdirSync(appDir, { recursive: true });
			mkdirSync(binDir, { recursive: true });
			const oldTarget = join(appDir, "Old-Signet.AppImage");
			writeFileSync(oldTarget, "old app");
			const binary = join(binDir, "signet-desktop");
			symlinkSync(oldTarget, binary);

			const result = installLinuxDesktopApp(root, home, join(home, "workspace"));

			expect(lstatSync(result.binary).isSymbolicLink()).toBe(false);
			expect(readFileSync(result.binary, "utf8")).toContain(`exec '${result.appImage}' "$@"`);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("syncs managed checkout before default install builds", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const workspace = join(home, "workspace");
		const calls: string[] = [];
		try {
			mkdirSync(workspace, { recursive: true });
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "app");

			const result = installDesktopFromSource(
				{},
				{
					home,
					env: { SIGNET_PATH: workspace },
					platform: "linux",
					syncWorkspaceSourceRepo: (workspaceDir) => {
						calls.push(`sync ${workspaceDir}`);
						return {
							status: "pulled",
							path: root,
							message: "pulled latest Signet source checkout",
							branch: "main",
							defaultBranch: "main",
						};
					},
					runner: (cmd, args, opts) => {
						calls.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`);
						return { status: 0 };
					},
				},
			);

			expect(existsSync(result.appImage)).toBe(true);
			expect(calls).toEqual([`sync ${workspace}`, `bun install @ ${root}`, `bun run build:desktop @ ${root}`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("skip-build install does not run build commands", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "app");

			const result = installDesktopFromSource(
				{ repo: root, skipBuild: true },
				{
					home,
					env: { SIGNET_PATH: join(home, "workspace") },
					platform: "linux",
					runner: () => {
						throw new Error("runner should not be called");
					},
				},
			);

			expect(existsSync(result.appImage)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
