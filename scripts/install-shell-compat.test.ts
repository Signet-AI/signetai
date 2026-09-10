import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const installer = join(root, "web", "marketing", "public", "install.sh");

function linkCommand(binDir: string, command: string): void {
	const path = Bun.which(command);
	if (!path) {
		throw new Error(`Required test command is not installed: ${command}`);
	}
	const result = spawnSync("ln", ["-s", path, join(binDir, command)], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`Could not link ${command}: ${result.stderr}`);
	}
}

describe("install.sh shell compatibility", () => {
	test("runs through bash and zsh without jq or Bash-only matching", () => {
		const workspace = mkdtempSync(join(tmpdir(), "signet-install-shell-"));
		const binDir = join(workspace, "bin");
		const fixtureDir = join(workspace, "fixtures");
		const downloadDir = join(workspace, "downloads");
		const argsPath = join(workspace, "install-args");
		mkdirSync(binDir);
		mkdirSync(fixtureDir);
		mkdirSync(downloadDir);

		try {
			for (const command of [
				"awk",
				"basename",
				"cat",
				"chmod",
				"cp",
				"mkdir",
				"rm",
				"sed",
				"sha256sum",
				"tr",
				"uname",
			]) {
				linkCommand(binDir, command);
			}

			// Keep the fixture aligned with the host that runs the shell test. The
			// installer intentionally derives its asset key from uname, so a
			// Linux-only manifest makes this otherwise portable test fail on macOS.
			const hostOs = spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim().toLowerCase();
			const hostArch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
			const fixtureOs = hostOs === "darwin" ? "darwin" : hostOs === "linux" ? "linux" : hostOs;
			const fixtureArch =
				hostArch === "x86_64" || hostArch === "amd64" ? "x64" : hostArch === "aarch64" ? "arm64" : hostArch;
			const fixturePlatform = `${fixtureOs}-${fixtureArch}`;

			const curl = join(binDir, "curl");
			writeFileSync(
				curl,
				`#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		-o) output="$2"; shift 2 ;;
		*) url="$1"; shift ;;
	esac
done
file="\${url##*/}"
if [ -n "$output" ]; then
	cp "$FIXTURE_ROOT/$file" "$output"
else
	cat "$FIXTURE_ROOT/$file"
fi
`,
			);
			chmodSync(curl, 0o755);

			const binary = `#!/bin/sh
printf '%s\\n' "$@" > "$SIGNET_INSTALL_ARGS"
`;
			const binaryName = `signet-${fixturePlatform}`;
			writeFileSync(join(fixtureDir, binaryName), binary);
			const connectorName = "signet-connectors-v-test.tar.gz";
			const connectorArchive = Buffer.from("connector archive");
			writeFileSync(join(fixtureDir, connectorName), connectorArchive);
			const daemonJsName = "signet-daemon-js-v-test.tar.gz";
			const daemonJsArchive = Buffer.from("bun-js archive");
			writeFileSync(join(fixtureDir, daemonJsName), daemonJsArchive);
			writeFileSync(
				join(fixtureDir, "native-manifest.json"),
				JSON.stringify({
					assets: [
						{
							platform: fixturePlatform,
							sha256: createHash("sha256").update(binary).digest("hex"),
						},
					],
					components: {
						connectors: {
							url: connectorName,
							sha256: createHash("sha256").update(connectorArchive).digest("hex"),
						},
						daemonJs: {
							url: daemonJsName,
							sha256: createHash("sha256").update(daemonJsArchive).digest("hex"),
						},
					},
				}),
			);

			for (const shell of ["bash", "zsh"]) {
				const shellPath = Bun.which(shell);
				if (!shellPath) {
					throw new Error(`Required test shell is not installed: ${shell}`);
				}
				for (const invocation of ["direct", "source"]) {
					rmSync(argsPath, { force: true });
					const args = invocation === "source" ? ["-c", 'source "$1" --json', shell, installer] : [installer, "--json"];
					const result = spawnSync(shellPath, args, {
						encoding: "utf8",
						env: {
							...process.env,
							FIXTURE_ROOT: fixtureDir,
							PATH: binDir,
							SIGNET_DOWNLOAD_BASE: "https://fixtures.invalid/v-test",
							SIGNET_DOWNLOAD_DIR: downloadDir,
							SIGNET_INSTALL_ARGS: argsPath,
						},
					});

					expect(result.status, `${shell} ${invocation} stderr:\n${result.stderr}`).toBe(0);
					expect(readFileSync(argsPath, "utf8").split("\n")).toEqual([
						"install",
						"--force",
						"--connector-assets",
						join(downloadDir, connectorName),
						"--daemon-js-assets",
						join(downloadDir, daemonJsName),
						"--json",
						"",
					]);
				}
			}
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
