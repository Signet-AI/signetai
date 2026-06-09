import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.close();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-native-install-smoke-"));
	tempDirs.push(dir);
	return dir;
}

function platformKey(): string {
	const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${os}-${arch}`;
}

function fakeNativeBinary(): Buffer {
	return Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "install" ]; then
	shift
	bin_dir=""
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--bin-dir) bin_dir="$2"; shift 2 ;;
			--force | --json) shift ;;
			*) shift ;;
		esac
	done
	if [ -z "$bin_dir" ]; then
		echo "missing --bin-dir" >&2
		exit 1
	fi
	mkdir -p "$bin_dir"
	cp "$0" "$bin_dir/signet"
	chmod +x "$bin_dir/signet"
	echo '{"installed":true}'
	exit 0
fi
echo "fake native signet $*"
`);
}

interface CommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<CommandResult> {
	const { stdin, timeoutMs = 10_000 } = options;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({
				status,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`command did not exit within ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);
		timer.unref();
		if (stdin !== undefined && child.stdin) {
			child.stdin.write(stdin);
			child.stdin.end();
		}
	});
}

interface NativeReleaseServer {
	readonly downloadBase: string;
	readonly releasesApiBase: string;
}

async function serveNativeRelease(binary: Buffer): Promise<NativeReleaseServer> {
	const platform = platformKey();
	const assetName = process.platform === "win32" ? `signet-${platform}.exe` : `signet-${platform}`;
	const tag = "v0.0.0-test";
	const manifest = JSON.stringify({
		schemaVersion: 1,
		version: tag.slice(1),
		assets: [
			{
				name: assetName,
				platform,
				sha256: createHash("sha256").update(binary).digest("hex"),
				size: binary.length,
			},
		],
	});

	const server = createServer((req, res) => {
		if (req.url === "/releases") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify([{ tag_name: tag, draft: false, prerelease: true }]));
			return;
		}
		if (req.url === "/download/native-manifest.json" || req.url === `/download/${tag}/native-manifest.json`) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(manifest);
			return;
		}
		if (req.url === `/download/${assetName}` || req.url === `/download/${tag}/${assetName}`) {
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(binary);
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("native release smoke server did not bind to a TCP port");
	}
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		downloadBase: `${origin}/download`,
		releasesApiBase: `${origin}/releases`,
	};
}

describe("native install smoke", () => {
	test("curl installer installs the manifest-selected native binary", async () => {
		if (process.platform === "win32") return;

		const dir = tempDir();
		const binDir = join(dir, "bin");
		const downloadDir = join(dir, "downloads");
		const release = await serveNativeRelease(fakeNativeBinary());

		const result = await runCommand(
			"bash",
			[join(root, "web", "marketing", "public", "install.sh"), "--bin-dir", binDir, "--force", "--json"],
			{ ...process.env, HOME: dir, SIGNET_DOWNLOAD_BASE: release.downloadBase, SIGNET_DOWNLOAD_DIR: downloadDir },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"installed":true');
		expect(existsSync(join(binDir, "signet"))).toBe(true);
	});

	test("curl installer resolves prerelease native assets without releases/latest", async () => {
		if (process.platform === "win32") return;

		const dir = tempDir();
		const binDir = join(dir, "bin");
		const downloadDir = join(dir, "downloads");
		const release = await serveNativeRelease(fakeNativeBinary());

		const result = await runCommand(
			"bash",
			[join(root, "web", "marketing", "public", "install.sh"), "--bin-dir", binDir, "--force", "--json"],
			{
				...process.env,
				HOME: dir,
				SIGNET_DOWNLOAD_DIR: downloadDir,
				SIGNET_RELEASES_API_BASE: release.releasesApiBase,
				SIGNET_RELEASES_DOWNLOAD_BASE: release.downloadBase,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"installed":true');
		expect(existsSync(join(binDir, "signet"))).toBe(true);
	});

	test("npm wrapper launches native optional package with or without postinstall", async () => {
		if (process.platform === "win32") return;

		const dir = tempDir();
		const packageDir = join(dir, "signetai");
		const platform = platformKey();
		const nativePackageName = `signetai-${platform}`;
		const nativePackageDir = join(packageDir, "node_modules", nativePackageName);
		const nativePackageBin = join(nativePackageDir, "bin", "signet");
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(nativePackageDir, "bin"), { recursive: true });
		cpSync(join(root, "dist", "signetai", "scripts"), join(packageDir, "scripts"), { recursive: true });
		cpSync(join(root, "dist", "signetai", "bin"), join(packageDir, "bin"), { recursive: true });
		// The signet-mcp stdio bundle is a build artifact (gitignored).
		// It only exists after `bun run build:signetai`; copy it into the
		// fake install if present so the install-path probe below can run.
		// On a clean checkout this whole block is skipped — the dedicated
		// signet-mcp stdio smoke test (which also skips cleanly) covers
		// the bundle in isolation.
		const stdioSource = join(root, "dist", "signetai", "dist", "mcp-stdio.js");
		const hasStdioBundle = existsSync(stdioSource);
		if (hasStdioBundle) {
			cpSync(join(root, "dist", "signetai", "dist"), join(packageDir, "dist"), { recursive: true });
		}
		writeFileSync(join(packageDir, "package.json"), readFileSync(join(root, "dist", "signetai", "package.json")));
		writeFileSync(
			join(nativePackageDir, "package.json"),
			JSON.stringify({ name: nativePackageName, version: "0.0.0", type: "module" }),
		);
		writeFileSync(nativePackageBin, fakeNativeBinary());
		chmodSync(nativePackageBin, 0o755);

		const directWrapper = await runCommand("node", [join(packageDir, "bin", "signet.js"), "--version"], process.env);
		expect(directWrapper.status).toBe(0);
		expect(directWrapper.stdout).toContain("fake native signet --version");

		const install = await runCommand("node", [join(packageDir, "scripts", "install-native.js")], process.env);

		expect(install.status).toBe(0);
		expect(install.stdout).toContain(`Linked Signet native binary for ${platform}`);
		const installedBinary = join(packageDir, "native", "signet");
		expect(existsSync(installedBinary)).toBe(true);
		chmodSync(installedBinary, 0o755);

		const wrapper = await runCommand("node", [join(packageDir, "bin", "signet.js"), "--version"], process.env);
		expect(wrapper.status).toBe(0);
		expect(wrapper.stdout).toContain("fake native signet --version");

		// signet-mcp must be the self-contained stdio JSON-RPC bundle, not
		// a wrapper that forwards to the native binary. Beyond the file
		// presence check, exercise the bundle from a fake install layout
		// and assert it actually speaks JSON-RPC. This catches bundle-
		// level breakage (e.g. the bundle was never built, the alias
		// config is wrong, the entry file is missing) at the install
		// smoke layer. A typo in the `bin` field of
		// dist/signetai/package.json itself (e.g. `dist/mcpstdio.js`
		// pointing at a file that doesn't exist) is caught separately
		// by the manifest assertion in
		// scripts/check-publish-manifests.test.ts. Skipped on clean
		// checkouts where the bundle has not been built; full handshake
		// coverage lives in scripts/signet-mcp-stdio-smoke.test.ts.
		const mcpBinPath = join(packageDir, "dist", "mcp-stdio.js");
		if (!hasStdioBundle) return;

		expect(existsSync(mcpBinPath)).toBe(true);

		const initialize = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "native-install-smoke", version: "0" },
			},
		});
		const mcpProbe = await runCommand("node", [mcpBinPath], process.env, { stdin: `${initialize}\n` });
		expect(mcpProbe.status).toBe(0);
		const firstLine = mcpProbe.stdout.split("\n").find((line) => line.length > 0) ?? "";
		const parsed = JSON.parse(firstLine) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.error).toBeUndefined();
		expect(parsed.result).toBeDefined();
	});
});
