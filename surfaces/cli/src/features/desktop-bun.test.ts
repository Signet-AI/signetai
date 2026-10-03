import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBunVersionSupported, prepareDesktopBun, readDesktopBunVersion } from "./desktop-bun.js";

describe("desktop Bun preflight", () => {
	test.each(["1.3.14", "1.4.1", "1.4.2-canary.1", "unknown", ""])("rejects %s", (version) => {
		expect(desktopBunVersionSupported(version)).toBe(false);
	});
	test.each(["1.4.2", "1.4.10", "1.5.0", "2.0.0", "1.4.2+abc123"])("accepts %s", (version) => {
		expect(desktopBunVersionSupported(version)).toBe(true);
	});
	test("a supported version needs no prompt or upgrade", async () => {
		await prepareDesktopBun({
			readVersion: () => "1.4.2",
			confirmUpgrade: async () => {
				throw new Error("unexpected prompt");
			},
			upgrade: () => {
				throw new Error("unexpected upgrade");
			},
		});
	});
	test("declining stops without upgrading", async () => {
		await expect(
			prepareDesktopBun({
				readVersion: () => "1.3.14",
				confirmUpgrade: async (message) => {
					expect(message).toContain("1.3.14");
					expect(message).toContain("1.4.2");
					return false;
				},
				upgrade: () => {
					throw new Error("unexpected upgrade");
				},
			}),
		).rejects.toThrow("cancelled");
	});
	test("an accepted upgrade is checked again before proceeding", async () => {
		const calls: string[] = [];
		let version = "1.3.14";
		await prepareDesktopBun({
			readVersion: () => {
				calls.push("version");
				return version;
			},
			confirmUpgrade: async () => {
				calls.push("prompt");
				return true;
			},
			upgrade: () => {
				calls.push("upgrade");
				version = "1.4.2";
			},
		});
		expect(calls).toEqual(["version", "prompt", "upgrade", "version"]);
	});
	test("an upgrade that leaves an old version still blocks", async () => {
		await expect(
			prepareDesktopBun({
				readVersion: () => "1.3.14",
				confirmUpgrade: async () => true,
				upgrade: () => {},
			}),
		).rejects.toThrow("require Bun 1.4.2");
	});
	test("upgrade failures propagate", async () => {
		await expect(
			prepareDesktopBun({
				readVersion: () => "1.3.14",
				confirmUpgrade: async () => true,
				upgrade: () => {
					throw new Error("upgrade failed");
				},
			}),
		).rejects.toThrow("upgrade failed");
	});
	test.skipIf(process.platform === "win32")("checks the Bun executable selected by PATH and fails if absent", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-bun-preflight-"));
		try {
			const path = join(root, "bun");
			writeFileSync(path, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "1.3.14\\n"\n');
			chmodSync(path, 0o755);
			expect(readDesktopBunVersion({ PATH: root })).toBe("1.3.14");
			rmSync(path);
			expect(() => readDesktopBunVersion({ PATH: root })).toThrow("Could not check Bun");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32").each([false, true])(
		"runs the actual upgrade subprocess and rechecks its result (failure: %s)",
		(failUpgrade) => {
			withFakeBun((env, root) => {
				const result = spawnSync(
					process.execPath,
					[
						"-e",
						`
					import { prepareDesktopBun } from ${JSON.stringify(join(import.meta.dir, "desktop-bun.ts"))};
					await prepareDesktopBun({ confirmUpgrade: async () => true });
					console.log("ready");
				`,
					],
					{
						env: { ...env, SIGNET_TEST_BUN_UPGRADE_FAIL: failUpgrade ? "1" : "0" },
						encoding: "utf8",
						timeout: 10_000,
					},
				);
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(failUpgrade ? 1 : 0);
				expect(readFileSync(join(root, "calls"), "utf8")).toBe(
					failUpgrade ? "--version \nupgrade --stable\n" : "--version \nupgrade --stable\n--version \n",
				);
				if (failUpgrade) {
					expect(result.stderr).toContain("Bun upgrade failed");
					expect(result.stdout).not.toContain("ready");
				} else {
					expect(result.stdout).toContain("ready");
				}
			});
		},
	);

	test.skipIf(process.platform === "win32")("non-interactive install exits before upgrading or installing", () => {
		withFakeBun((env, root) => {
			const result = spawnSync(
				process.execPath,
				[
					"-e",
					`
				import { Command } from "commander";
				import { registerDesktopCommands } from ${JSON.stringify(join(import.meta.dir, "../commands/desktop.ts"))};
				const program = new Command();
				registerDesktopCommands(program, {
					buildDesktopFromSource() { throw new Error("unexpected build"); },
					installDesktopFromSource() { throw new Error("unexpected install"); },
				});
				await program.parseAsync(["bun", "signet", "desktop", "install"]);
			`,
				],
				{ env, cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 10_000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("found 1.3.14");
			expect(result.stderr).toContain("Upgrade Bun manually");
			expect(result.stderr).not.toContain("now?");
			expect(result.stderr).not.toContain("unexpected");
			expect(readFileSync(join(root, "calls"), "utf8")).toBe("--version \n");
		});
	});
});

function withFakeBun(run: (env: NodeJS.ProcessEnv, root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "signet-bun-upgrade-"));
	try {
		const path = join(root, "bun");
		writeFileSync(join(root, "version"), "1.3.14\n");
		writeFileSync(
			path,
			`#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> "$SIGNET_TEST_BUN_LOG"
case "$1" in
  --version) read -r version < "$SIGNET_TEST_BUN_STATE"; printf '%s\\n' "$version" ;;
  upgrade) [ "$2" = "--stable" ] || exit 8
    [ "$SIGNET_TEST_BUN_UPGRADE_FAIL" = "1" ] && exit 7
    printf '1.4.2\\n' > "$SIGNET_TEST_BUN_STATE" ;;
  *) exit 9 ;;
esac
`,
		);
		chmodSync(path, 0o755);
		run(
			{
				...process.env,
				PATH: root,
				SIGNET_TEST_BUN_STATE: join(root, "version"),
				SIGNET_TEST_BUN_LOG: join(root, "calls"),
			},
			root,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
