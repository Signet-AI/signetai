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
	installMacDesktopApp,
	installWindowsDesktopApp,
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
					syncWorkspaceSourceRepo: (workspaceDir, options) => {
						expect(options).toEqual({ cloneIfMissing: true });
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
			expect(readFileSync(result.desktopEntry, "utf8")).toContain(`Exec="${result.binary}" %U`);
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

	test("refuses to replace an existing foreign AppImage", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet-0.1.0-linux-x86_64.AppImage"), "new app");
			const appDir = join(home, ".local", "share", "signet", "desktop");
			mkdirSync(appDir, { recursive: true });
			const existing = join(appDir, "Signet.AppImage");
			writeFileSync(existing, "foreign app");

			expect(() => installLinuxDesktopApp(root, home, join(home, "workspace"))).toThrow(
				"Refusing to replace existing AppImage",
			);
			expect(readFileSync(existing, "utf8")).toBe("foreign app");
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
			const binDir = join(home, ".local", "bin");
			mkdirSync(binDir, { recursive: true });
			writeFileSync(join(binDir, "signet-desktop"), "# signet-desktop managed launcher\n");

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
					syncWorkspaceSourceRepo: (workspaceDir, options) => {
						expect(options).toEqual({ cloneIfMissing: true });
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

function makeMacAppBundle(dir: string, arch: "x64" | "arm64", executable = "signet"): string {
	const app = join(dir, "Signet.app");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	writeFileSync(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleIdentifier</key><string>ai.signet.app</string></dict></plist>\n`,
	);
	// Mach-O 64-bit magic (MH_MAGIC_64, little-endian) followed by cputype.
	const header = Buffer.alloc(8);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
	writeFileSync(join(app, "Contents", "MacOS", executable), header);
	return app;
}

function makeUniversalMacAppBundle(
	dir: string,
	architectures: readonly ("x64" | "arm64")[],
	executable = "signet",
): string {
	const app = join(dir, "Signet.app");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	writeFileSync(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleIdentifier</key><string>ai.signet.app</string></dict></plist>\n`,
	);
	const entrySize = 20;
	const tableSize = 8 + architectures.length * entrySize;
	const header = Buffer.alloc(tableSize + architectures.length * 8);
	header.writeUInt32BE(0xcafebabe, 0);
	header.writeUInt32BE(architectures.length, 4);
	for (const [index, architecture] of architectures.entries()) {
		const entry = 8 + index * entrySize;
		const sliceOffset = tableSize + index * 8;
		header.writeUInt32BE(architecture === "arm64" ? 0x0100000c : 0x01000007, entry);
		header.writeUInt32BE(0, entry + 4);
		header.writeUInt32BE(sliceOffset, entry + 8);
		header.writeUInt32BE(8, entry + 12);
		header.writeUInt32BE(2, entry + 16);
	}
	writeFileSync(join(app, "Contents", "MacOS", executable), header);
	return app;
}

function hostDesktopArch(): "x64" | "arm64" {
	return process.arch === "arm64" ? "arm64" : "x64";
}

function makeWindowsAppDirectory(dir: string, arch: "x64" | "arm64", packageName = "@signet/desktop"): string {
	const app = join(dir, `win-${arch}-unpacked`);
	return makeWindowsAppContents(app, arch, packageName);
}

function makeWindowsAppContents(app: string, arch: "x64" | "arm64", packageName = "@signet/desktop"): string {
	mkdirSync(join(app, "resources"), { recursive: true });
	writeFileSync(join(app, "resources", "app.asar"), JSON.stringify({ name: packageName }));
	const header = Buffer.alloc(512);
	header.write("MZ", 0, 2, "ascii");
	header.writeUInt32LE(0x80, 0x3c);
	header.write("PE\u0000\u0000", 0x80, 4, "ascii");
	header.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x84);
	writeFileSync(join(app, "signet.exe"), header);
	return app;
}

describe("mac desktop install", () => {
	test("installs the newest matching .app bundle into ~/Applications", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release", "mac");
			mkdirSync(release, { recursive: true });
			const app = makeMacAppBundle(release, process.arch === "arm64" ? "arm64" : "x64");
			utimesSync(app, new Date(2_000), new Date(2_000));

			const workspace = join(home, "workspace");
			const result = installMacDesktopApp(root, home, workspace);

			expect(result.appBundle).toBe(join(home, "Applications", "Signet.app"));
			expect(existsSync(join(result.appBundle, "Contents", "Info.plist"))).toBe(true);
			expect(result.workspace).toBe(workspace);
			expect(
				existsSync(join(home, "Applications", ".Signet.app.")) ||
					readdirSync(join(home, "Applications")).some((name) => name.startsWith(".Signet.app.")),
			).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("accepts a universal bundle containing the host architecture", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release", "mac");
			mkdirSync(release, { recursive: true });
			makeUniversalMacAppBundle(release, ["x64", "arm64"]);

			const result = installMacDesktopApp(root, home, join(home, "workspace"));

			expect(existsSync(result.appBundle)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("refuses to replace a non-Signet app bundle", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release", "mac");
			mkdirSync(release, { recursive: true });
			makeMacAppBundle(release, process.arch === "arm64" ? "arm64" : "x64");

			const applications = join(home, "Applications");
			mkdirSync(applications, { recursive: true });
			const foreign = makeMacAppBundle(applications, process.arch === "arm64" ? "arm64" : "x64");
			renameSync(foreign, join(applications, "Signet.app"));
			// Rewrite its plist so it is no longer Signet-owned.
			writeFileSync(
				join(applications, "Signet.app", "Contents", "Info.plist"),
				`<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>\n`,
			);

			expect(() => installMacDesktopApp(root, home, join(home, "workspace"))).toThrow(
				"Refusing to replace existing app",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("replaces an existing Signet-owned bundle", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release", "mac");
			mkdirSync(release, { recursive: true });
			makeMacAppBundle(release, process.arch === "arm64" ? "arm64" : "x64");

			const applications = join(home, "Applications");
			mkdirSync(applications, { recursive: true });
			makeMacAppBundle(applications, process.arch === "arm64" ? "arm64" : "x64");

			const result = installMacDesktopApp(root, home, join(home, "workspace"));

			expect(existsSync(result.appBundle)).toBe(true);
			expect(readdirSync(applications).filter((name) => name.endsWith(".app"))).toEqual(["Signet.app"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("keeps the installed app when the replacement copy fails", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		const sourceExecutable = join(
			root,
			"surfaces",
			"desktop",
			"release",
			"mac",
			"Signet.app",
			"Contents",
			"MacOS",
			"signet",
		);
		try {
			const release = join(root, "surfaces", "desktop", "release", "mac");
			mkdirSync(release, { recursive: true });
			// An unreadable non-executable resource makes cpSync fail mid-copy
			// while the bundle still passes the pre-selection arch check (which
			// only reads the Mach-O executable). The pre-fix code deleted the
			// installed app BEFORE the copy, so this failure left the user with
			// no installed app at all.
			const source = makeMacAppBundle(release, process.arch === "arm64" ? "arm64" : "x64");
			const doomed = join(source, "Contents", "Resources", "doomed.bin");
			mkdirSync(join(source, "Contents", "Resources"), { recursive: true });
			writeFileSync(doomed, "payload");
			chmodSync(doomed, 0o000);

			const applications = join(home, "Applications");
			mkdirSync(applications, { recursive: true });
			makeMacAppBundle(applications, process.arch === "arm64" ? "arm64" : "x64");

			expect(() => installMacDesktopApp(root, home, join(home, "workspace"))).toThrow();
			// The previously installed bundle survived the failed install...
			expect(existsSync(join(applications, "Signet.app", "Contents", "Info.plist"))).toBe(true);
			// ...and no swap debris was left behind.
			expect(readdirSync(applications).some((name) => name.includes(".previous-"))).toBe(false);
			expect(readdirSync(applications).some((name) => name.startsWith(".Signet.app."))).toBe(false);
		} finally {
			if (existsSync(sourceExecutable)) {
				// Not strictly required (only Resources/doomed.bin was locked), but
				// keep the tree removable regardless of platform semantics.
				chmodSync(sourceExecutable, 0o755);
			}
			chmodSync(
				join(root, "surfaces", "desktop", "release", "mac", "Signet.app", "Contents", "Resources", "doomed.bin"),
				0o644,
			);
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("skips foreign-arch bundles and installs the matching one", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			// Two candidate layouts: an arm64 build and the host-arch build.
			const armDir = join(release, "mac_arm64");
			const hostDir = join(release, "mac");
			mkdirSync(armDir, { recursive: true });
			mkdirSync(hostDir, { recursive: true });
			const armApp = makeMacAppBundle(armDir, "arm64");
			const hostApp = makeMacAppBundle(hostDir, process.arch === "arm64" ? "arm64" : "x64");
			// Make the foreign-arch artifact the newest; arch check must win.
			utimesSync(armApp, new Date(9_000), new Date(9_000));
			utimesSync(hostApp, new Date(2_000), new Date(2_000));

			const result = installMacDesktopApp(root, home, join(home, "workspace"));

			expect(result.appBundle).toBe(join(home, "Applications", "Signet.app"));
			expect(existsSync(result.appBundle)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("Windows desktop install", () => {
	test("installs the matching unpacked build without touching the native CLI directory", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			const source = makeWindowsAppDirectory(release, hostDesktopArch());
			const workspace = join(home, "workspace");

			const result = installWindowsDesktopApp(root, home, workspace);

			expect(result.appDir).toBe(join(home, "AppData", "Local", "Programs", "Signet Desktop"));
			expect(result.programsDir).toBe(join(home, "AppData", "Local", "Programs"));
			expect(result.executable).toBe(join(result.appDir, "signet.exe"));
			expect(existsSync(result.executable)).toBe(true);
			expect(existsSync(join(home, "AppData", "Local", "Programs", "Signet", "signet.exe"))).toBe(false);
			expect(source).not.toBe(result.appDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("refuses to replace a foreign application in the managed directory", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			makeWindowsAppDirectory(release, hostDesktopArch());

			const appDir = join(home, "AppData", "Local", "Programs", "Signet Desktop");
			makeWindowsAppContents(appDir, hostDesktopArch(), "com.example.other");

			expect(() => installWindowsDesktopApp(root, home, join(home, "workspace"))).toThrow(
				"Refusing to replace existing Windows app directory",
			);
			expect(readFileSync(join(appDir, "resources", "app.asar"), "utf8")).toContain("com.example.other");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("dispatches Windows through the shared desktop install entrypoint", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			mkdirSync(release, { recursive: true });
			makeWindowsAppDirectory(release, hostDesktopArch());
			const workspace = join(home, "workspace");
			const localAppData = join(home, "local-app-data");

			const result = installDesktopFromSource(
				{ repo: root, skipBuild: true },
				{
					env: { SIGNET_PATH: workspace, LOCALAPPDATA: localAppData },
					home,
					platform: "win32",
					runner: () => {
						throw new Error("runner should not be called");
					},
				},
			);

			if (!("appDir" in result)) throw new Error("expected Windows install result");
			expect(result.workspace).toBe(workspace);
			expect(result.appDir).toBe(join(localAppData, "Programs", "Signet Desktop"));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("does not select a newest foreign-architecture build", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "surfaces", "desktop", "release");
			const host = makeWindowsAppDirectory(release, hostDesktopArch());
			const foreign = makeWindowsAppDirectory(release, hostDesktopArch() === "arm64" ? "x64" : "arm64");
			utimesSync(host, new Date(2_000), new Date(2_000));
			utimesSync(foreign, new Date(9_000), new Date(9_000));

			const result = installWindowsDesktopApp(root, home, join(home, "workspace"));

			expect(existsSync(result.executable)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
