import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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

interface ConnectorReleaseServer {
	readonly downloadBase: string;
	readonly version: string;
}

async function serveConnectorRelease(
	connectorTarball: Buffer,
	version: string,
): Promise<ConnectorReleaseServer> {
	const sha256 = createHash("sha256").update(connectorTarball).digest("hex");
	const manifest = JSON.stringify({
		schemaVersion: 1,
		version,
		assets: [],
		components: {
			connectors: {
				url: `signet-connectors-${version}.tar.gz`,
				sha256,
				size: connectorTarball.length,
			},
		},
	});

	const server = createServer((req, res) => {
		if (
			req.url === "/download/native-manifest.json" ||
			req.url === `/download/v${version}/native-manifest.json`
		) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(manifest);
			return;
		}
		if (
			req.url === `/download/signet-connectors-${version}.tar.gz` ||
			req.url === `/download/v${version}/signet-connectors-${version}.tar.gz`
		) {
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(connectorTarball);
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
		throw new Error("connector release smoke server did not bind to a TCP port");
	}
	return {
		downloadBase: `http://127.0.0.1:${address.port}/download`,
		version,
	};
}

function buildFakeConnectorTarball(): Buffer {
	// Build a real tar.gz with a `runtime/connectors/hermes-agent/hermes-plugin/...`
	// layout so the install path's tar extraction is exercised end-to-end.
	// Tar the explicit directory entries to avoid tar seeing the staging
	// dir as "file changed as we read it" under aggressive test-runner
	// file-watching.
	const stage = mkdtempSync(join(tmpdir(), "signet-connector-tar-"));
	tempDirs.push(stage);
	const pluginDir = join(stage, "runtime", "connectors", "hermes-agent", "hermes-plugin");
	mkdirSync(pluginDir, { recursive: true });
	writeFileSync(
		join(pluginDir, "__init__.py"),
		"\"\"\"Smoke test plugin for issue #831 connector install path.\"\"\"\n",
	);
	writeFileSync(join(pluginDir, "plugin.yaml"), "name: signet\nversion: 1.0.0\n");
	const tarballPath = join(stage, "out.tar.gz");
	const tar = spawnSync(
		"tar",
		[
			"czf",
			tarballPath,
			"-C",
			stage,
			"runtime/connectors/hermes-agent/hermes-plugin/__init__.py",
			"runtime/connectors/hermes-agent/hermes-plugin/plugin.yaml",
		],
		{ stdio: "pipe" },
	);
	if (tar.status !== 0) {
		throw new Error(
			`tar staging failed: status ${tar.status ?? "unknown"} stderr=${tar.stderr?.toString() ?? "(none)"}`,
		);
	}
	const buf = readFileSync(tarballPath);
	rmSync(stage, { recursive: true, force: true });
	const idx = tempDirs.indexOf(stage);
	if (idx >= 0) tempDirs.splice(idx, 1);
	return buf;
}

describe("native install smoke", () => {
	test("postinstall extracts connector assets from a manifest-aware release", async () => {
		if (process.platform === "win32") return;

		const version = "0.0.0-smoke-831";
		const tarball = buildFakeConnectorTarball();
		const release = await serveConnectorRelease(tarball, version);

		const dir = tempDir();
		const packageDir = join(dir, "signetai");
		const platform = platformKey();
		const nativePackageName = `signetai-${platform}`;
		const nativePackageDir = join(packageDir, "node_modules", nativePackageName);
		const nativePackageBin = join(nativePackageDir, "bin", "signet");
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(nativePackageDir, "bin"), { recursive: true });
		cpSync(join(root, "dist", "signetai", "scripts"), join(packageDir, "scripts"), {
			recursive: true,
		});
		cpSync(join(root, "dist", "signetai", "bin"), join(packageDir, "bin"), {
			recursive: true,
		});
		// Stash the manifest in the wrapper root. `install-native.js`
		// looks for `native-manifest.json` next to the wrapper's own
		// package.json.
		const manifest = JSON.stringify({
			schemaVersion: 1,
			version,
			assets: [],
			components: {
				connectors: {
					url: `signet-connectors-${version}.tar.gz`,
					sha256: createHash("sha256").update(tarball).digest("hex"),
					size: tarball.length,
				},
			},
		});
		writeFileSync(join(packageDir, "native-manifest.json"), manifest);
		writeFileSync(
			join(nativePackageDir, "package.json"),
			JSON.stringify({ name: nativePackageName, version, type: "module" }),
		);
		// Native binary can be empty here — the connector install path
		// runs even when the binary link is skipped.
		writeFileSync(nativePackageBin, "");
		chmodSync(nativePackageBin, 0o755);

		const result = await runCommand(
			"node",
			[join(packageDir, "scripts", "install-native.js")],
			{ ...process.env, SIGNET_DOWNLOAD_BASE: release.downloadBase },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Installed connector assets to");

		// Tarball layout puts files at `<packageDir>/runtime/connectors/...`.
		// This is the path the binary's `$SIGNET_DIR/runtime/connectors/...`
		// lookup resolves to, and the layout the connector's
		// `getPluginSourceDir()` expects.
		const extractedDir = join(
			packageDir,
			"runtime",
			"connectors",
			"hermes-agent",
			"hermes-plugin",
		);
		expect(existsSync(join(extractedDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(extractedDir, "plugin.yaml"))).toBe(true);
		expect(
			readFileSync(join(extractedDir, "__init__.py"), "utf8"),
		).toContain("Smoke test plugin for issue #831");
		expect(
			readFileSync(join(packageDir, "runtime", "connectors", ".signet-connectors-version"), "utf8").trim(),
		).toBe(version);
	});

	test("postinstall rejects a tarball whose SHA-256 does not match the manifest", async () => {
		if (process.platform === "win32") return;

		const version = "0.0.0-smoke-831-bad";
		const tarball = buildFakeConnectorTarball();
		// Serve a manifest with a wrong SHA so verification must fail.
		const wrongSha = "0".repeat(64);
		const server = createServer((req, res) => {
			if (
				req.url === "/download/native-manifest.json" ||
				req.url === `/download/v${version}/native-manifest.json`
			) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						schemaVersion: 1,
						version,
						assets: [],
						components: {
							connectors: {
								url: `signet-connectors-${version}.tar.gz`,
								sha256: wrongSha,
								size: tarball.length,
							},
						},
					}),
				);
				return;
			}
			if (
				req.url === `/download/signet-connectors-${version}.tar.gz` ||
				req.url === `/download/v${version}/signet-connectors-${version}.tar.gz`
			) {
				res.writeHead(200, { "Content-Type": "application/octet-stream" });
				res.end(tarball);
				return;
			}
			res.writeHead(404);
			res.end("not found");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("connector bad-sha server did not bind to a TCP port");
		}

		const dir = tempDir();
		const packageDir = join(dir, "signetai");
		const platform = platformKey();
		const nativePackageName = `signetai-${platform}`;
		const nativePackageDir = join(packageDir, "node_modules", nativePackageName);
		const nativePackageBin = join(nativePackageDir, "bin", "signet");
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(nativePackageDir, "bin"), { recursive: true });
		cpSync(join(root, "dist", "signetai", "scripts"), join(packageDir, "scripts"), {
			recursive: true,
		});
		cpSync(join(root, "dist", "signetai", "bin"), join(packageDir, "bin"), {
			recursive: true,
		});
		// The wrapper-side manifest must match what the HTTP server
		// advertises, otherwise the postinstall skips the connector
		// install entirely (no URL to fetch from). We override the
		// SHA via the test server so the postinstall sees a mismatching
		// value and bails out with the expected error.
		const manifest = JSON.stringify({
			schemaVersion: 1,
			version,
			assets: [],
			components: {
				connectors: {
					url: `signet-connectors-${version}.tar.gz`,
					sha256: "0".repeat(64),
					size: tarball.length,
				},
			},
		});
		writeFileSync(join(packageDir, "native-manifest.json"), manifest);
		writeFileSync(
			join(nativePackageDir, "package.json"),
			JSON.stringify({ name: nativePackageName, version, type: "module" }),
		);
		writeFileSync(nativePackageBin, "");
		chmodSync(nativePackageBin, 0o755);

		const result = await runCommand(
			"node",
			[join(packageDir, "scripts", "install-native.js")],
			{ ...process.env, SIGNET_DOWNLOAD_BASE: `http://127.0.0.1:${address.port}/download` },
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("SHA-256 mismatch");
	});

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
