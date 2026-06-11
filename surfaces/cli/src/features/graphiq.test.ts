import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	getGraphiqProjectDbPath,
	readGraphiqState,
	updateGraphiqActiveProject,
	writeGraphiqState,
} from "@signet/core";
import {
	ensureGraphiqInstalled,
	installGraphiqPlugin,
	resolveInstallScriptPath,
	runGraphiqDoctor,
	uninstallGraphiqPlugin,
} from "./graphiq.js";
import { readSetupCorePluginEnabled } from "./setup-plugins.js";

let tempRoot = "";

function graphiqTarballForHost(): string {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "darwin" && arch === "arm64") return "graphiq-aarch64-apple-darwin.tar.gz";
	if (platform === "darwin" && arch === "x64") return "graphiq-x86_64-apple-darwin.tar.gz";
	if (platform === "linux" && arch === "x64") return "graphiq-x86_64-unknown-linux-gnu.tar.gz";
	if (platform === "linux" && (arch === "arm64" || arch === "arm")) {
		return "graphiq-aarch64-unknown-linux-gnu.tar.gz";
	}
	throw new Error(`Unsupported host target in test: ${platform}/${arch}`);
}

function makeRoot(): string {
	tempRoot = mkdtempSync(join(tmpdir(), "signet-graphiq-cli-"));
	return tempRoot;
}

afterEach(() => {
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	tempRoot = "";
});

describe("GraphIQ plugin install", () => {
	test("resolves bundled install script beside packaged CLI dist", () => {
		const basePath = makeRoot();
		const distDir = join(basePath, "node_modules", "signetai", "dist");
		const scriptsDir = join(basePath, "node_modules", "signetai", "scripts");
		const scriptPath = join(scriptsDir, "install-graphiq.sh");
		mkdirSync(scriptsDir, { recursive: true });
		mkdirSync(distDir, { recursive: true });
		writeFileSync(scriptPath, "#!/bin/sh\n");

		expect(resolveInstallScriptPath(distDir)).toBe(resolve(scriptPath));
	});

	test("falls back to source-tree install script during local development", () => {
		const basePath = makeRoot();
		const featureDir = join(basePath, "surfaces", "cli", "src", "features");
		const scriptsDir = join(basePath, "scripts");
		const scriptPath = join(scriptsDir, "install-graphiq.sh");
		mkdirSync(featureDir, { recursive: true });
		mkdirSync(scriptsDir, { recursive: true });
		writeFileSync(scriptPath, "#!/bin/sh\n");

		expect(resolveInstallScriptPath(featureDir)).toBe(resolve(scriptPath));
	});

	test("disables persisted GraphIQ runtime state when install fails", async () => {
		const basePath = makeRoot();
		const projectPath = join(basePath, "project");
		mkdirSync(projectPath, { recursive: true });
		updateGraphiqActiveProject(basePath, {
			projectPath,
			indexedAt: new Date("2026-04-21T00:00:00.000Z"),
			installSource: "existing",
		});

		const originalPath = process.env.PATH;
		const emptyBin = join(basePath, "empty-bin");
		mkdirSync(emptyBin, { recursive: true });
		process.env.PATH = emptyBin;
		try {
			await expect(installGraphiqPlugin({ agentsDir: basePath })).resolves.toBe(false);
		} finally {
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		expect(readSetupCorePluginEnabled(basePath, SIGNET_GRAPHIQ_PLUGIN_ID)).toBe(false);
		const state = readGraphiqState(basePath);
		expect(state.enabled).toBe(false);
		expect(state.activeProject).toBe(projectPath);
	});

	test("uses install script for GraphIQ installation", async () => {
		const basePath = makeRoot();
		const binDir = join(basePath, "bin");
		const capturePath = join(basePath, "install-args.txt");
		mkdirSync(binDir, { recursive: true });
		const bashPath = join(binDir, "bash");
		writeFileSync(bashPath, `#!/bin/sh\necho "$@" >> ${JSON.stringify(capturePath)}\nexit 0\n`);
		chmodSync(bashPath, 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = binDir;
		try {
			await expect(ensureGraphiqInstalled({ installIfMissing: true })).resolves.toBe(null);
		} finally {
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		const args = readFileSync(capturePath, "utf-8");
		expect(args).toContain("install");
	});

	test("install script exits successfully after a completed install", () => {
		const basePath = makeRoot();
		const fakeBin = join(basePath, "fake-bin");
		const installDir = join(basePath, "install-bin");
		const fixtureDir = join(basePath, "fixtures");
		const tarballName = graphiqTarballForHost();
		const tarballPath = join(fixtureDir, tarballName);
		const curlPath = join(fakeBin, "curl");
		const graphiqFixture = join(fixtureDir, "graphiq");
		const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/install-graphiq.sh");
		mkdirSync(fakeBin, { recursive: true });
		mkdirSync(installDir, { recursive: true });
		mkdirSync(fixtureDir, { recursive: true });
		writeFileSync(graphiqFixture, "#!/bin/sh\necho graphiq fixture\n");
		chmodSync(graphiqFixture, 0o755);
		const tarResult = spawnSync("tar", ["-czf", tarballPath, "-C", fixtureDir, "graphiq"], { encoding: "utf-8" });
		expect(tarResult.status).toBe(0);
		const expectedSha = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
		expect(expectedSha.length).toBe(64);
		writeFileSync(
			curlPath,
			`#!/bin/sh
set -eu
url=""
dest=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		-o)
			dest="$2"
			shift 2
			;;
		*)
			url="$1"
			shift
			;;
	esac
done
if [ -n "$dest" ]; then
	cp ${JSON.stringify(tarballPath)} "$dest"
	exit 0
fi
cat <<'JSON'
{"tag_name":"v3.3.1","assets":[{"name":"${tarballName}","digest":"sha256:${expectedSha}"}]}
JSON
`,
		);
		chmodSync(curlPath, 0o755);

		const result = spawnSync("bash", [scriptPath, "install"], {
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
				GRAPHIQ_ALLOW_LATEST: "1",
				GRAPHIQ_INSTALL_DIR: installDir,
			},
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(existsSync(join(installDir, "graphiq"))).toBe(true);
	});

	test("does not run GraphIQ without --db when active project metadata is missing", async () => {
		const basePath = makeRoot();
		const projectPath = join(basePath, "project");
		mkdirSync(projectPath, { recursive: true });
		writeGraphiqState(basePath, {
			pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
			enabled: true,
			managedBy: "signet",
			activeProject: projectPath,
			indexedProjects: [],
			updatedAt: "2026-04-21T00:00:00.000Z",
		});

		const binDir = join(basePath, "bin");
		const capturePath = join(basePath, "graphiq-args.txt");
		mkdirSync(binDir, { recursive: true });
		const graphiqPath = join(binDir, "graphiq");
		writeFileSync(graphiqPath, `#!/bin/sh\necho "$@" > ${JSON.stringify(capturePath)}\n`);
		chmodSync(graphiqPath, 0o755);

		const originalPath = process.env.PATH;
		const originalError = console.error;
		const errors: string[] = [];
		process.env.PATH = binDir;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await runGraphiqDoctor({ agentsDir: basePath });
		} finally {
			console.error = originalError;
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
		}

		expect(existsSync(capturePath)).toBe(false);
		expect(errors.join("\n")).toContain("GraphIQ index metadata is missing");
	});

	test("purge indexes only removes GraphIQ dirs that match indexed project metadata", async () => {
		const basePath = makeRoot();
		const validProjectPath = join(basePath, "valid-project");
		const tamperedProjectPath = join(basePath, "tampered-project");
		const outsidePath = join(basePath, "outside");
		const validDbPath = getGraphiqProjectDbPath(validProjectPath);
		const outsideDbPath = join(outsidePath, ".graphiq", "graphiq.db");

		mkdirSync(dirname(validDbPath), { recursive: true });
		mkdirSync(dirname(outsideDbPath), { recursive: true });
		writeFileSync(validDbPath, "");
		writeFileSync(outsideDbPath, "");
		writeGraphiqState(basePath, {
			pluginId: SIGNET_GRAPHIQ_PLUGIN_ID,
			enabled: true,
			managedBy: "signet",
			activeProject: validProjectPath,
			indexedProjects: [
				{
					path: validProjectPath,
					dbPath: validDbPath,
					lastIndexedAt: "2026-04-21T00:00:00.000Z",
				},
				{
					path: tamperedProjectPath,
					dbPath: outsideDbPath,
					lastIndexedAt: "2026-04-21T00:00:00.000Z",
				},
			],
			updatedAt: "2026-04-21T00:00:00.000Z",
		});

		await uninstallGraphiqPlugin({ purgeIndexes: true }, { agentsDir: basePath });

		expect(existsSync(dirname(validDbPath))).toBe(false);
		expect(existsSync(dirname(outsideDbPath))).toBe(true);
		expect(readGraphiqState(basePath).enabled).toBe(false);
	});
});
