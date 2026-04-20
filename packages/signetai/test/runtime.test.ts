import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunGlobalPackageRoots, isBunGlobalPackageDir, shouldRunCliWithBun } from "../bin/runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

describe("signet bin runtime selection", () => {
	it("recognizes the default Bun global package path", () => {
		expect(isBunGlobalPackageDir("/Users/jason/.bun/install/global/node_modules/signetai", {}, "/Users/jason")).toBe(
			true,
		);
	});

	it("recognizes custom BUN_INSTALL global package paths", () => {
		expect(
			isBunGlobalPackageDir(
				"/opt/bun/install/global/node_modules/signetai",
				{ BUN_INSTALL: "/opt/bun" },
				"/Users/jason",
			),
		).toBe(true);
	});

	it("matches Bun global paths case-insensitively on default case-insensitive platforms", () => {
		expect(
			isBunGlobalPackageDir("/Users/Jason/.bun/install/global/node_modules/signetai", {}, "/Users/jason", "darwin"),
		).toBe(true);
		expect(
			isBunGlobalPackageDir(
				"C:\\USERS\\JASON\\.bun\\install\\global\\node_modules\\signetai",
				{},
				"C:\\Users\\jason",
				"win32",
			),
		).toBe(true);
	});

	it("keeps path matching case-sensitive on Linux", () => {
		expect(
			isBunGlobalPackageDir("/home/Jason/.bun/install/global/node_modules/signetai", {}, "/home/jason", "linux"),
		).toBe(false);
	});

	it("does not treat npm global installs as Bun installs", () => {
		expect(isBunGlobalPackageDir("/usr/local/lib/node_modules/signetai", {}, "/Users/jason")).toBe(false);
	});

	it("re-runs the CLI with Bun only from Node in a Bun global install", () => {
		const packageDir = "/Users/jason/.bun/install/global/node_modules/signetai";

		expect(
			shouldRunCliWithBun({
				isBunRuntime: false,
				packageDir,
				bunAvailable: true,
				env: {},
				homeDir: "/Users/jason",
			}),
		).toBe(true);
		expect(
			shouldRunCliWithBun({
				isBunRuntime: true,
				packageDir,
				bunAvailable: true,
				env: {},
				homeDir: "/Users/jason",
			}),
		).toBe(false);
		expect(
			shouldRunCliWithBun({
				isBunRuntime: false,
				packageDir,
				bunAvailable: false,
				env: {},
				homeDir: "/Users/jason",
			}),
		).toBe(false);
	});

	it("deduplicates matching default and custom Bun install roots", () => {
		expect(bunGlobalPackageRoots({ BUN_INSTALL: "/Users/jason/.bun" }, "/Users/jason")).toEqual([
			"/Users/jason/.bun/install/global/node_modules/signetai",
		]);
	});

	it("re-executes a Bun global install through the bun binary", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-bun-global-"));
		const pkg = join(root, "install", "global", "node_modules", "signetai");
		const fakeBin = join(root, "bin");
		const argsFile = join(root, "bun-args.txt");

		try {
			mkdirSync(join(pkg, "bin"), { recursive: true });
			mkdirSync(join(pkg, "dist"), { recursive: true });
			mkdirSync(fakeBin, { recursive: true });
			copyFileSync(join(packageRoot, "bin", "signet.js"), join(pkg, "bin", "signet.js"));
			copyFileSync(join(packageRoot, "bin", "runtime.js"), join(pkg, "bin", "runtime.js"));
			writeFileSync(join(pkg, "dist", "cli.js"), "console.log('node cli should not run');\n");
			writeFileSync(
				join(fakeBin, "bun"),
				`#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "1.3.13"
  exit 0
fi
printf '%s\\n' "$@" > "$SIGNET_TEST_BUN_ARGS"
exit 17
`,
			);
			chmodSync(join(fakeBin, "bun"), 0o755);

			const result = spawnSync("node", [join(pkg, "bin", "signet.js"), "setup", "--non-interactive"], {
				encoding: "utf8",
				env: {
					...process.env,
					BUN_INSTALL: root,
					PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
					SIGNET_TEST_BUN_ARGS: argsFile,
				},
			});

			expect(result.status).toBe(17);
			expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
				join(pkg, "dist", "cli.js"),
				"setup",
				"--non-interactive",
			]);
			expect(result.stdout).not.toContain("node cli should not run");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
