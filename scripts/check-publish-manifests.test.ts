import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	collectManifestIssues,
	collectWorkspacePackages,
	isPublishableWorkspacePackage,
	listPublishableManifestTargets,
} from "./check-publish-manifests";

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function extractWorkflowRunBlock(workflow: string, step: string): string {
	const marker = `      - name: ${step}\n        `;
	const start = workflow.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const runStart = workflow.indexOf("run: |\n", start);
	expect(runStart).toBeGreaterThanOrEqual(0);
	const contentStart = runStart + "run: |\n".length;
	const nextStep = workflow.indexOf("\n      - name:", contentStart);
	const block = workflow.slice(contentStart, nextStep === -1 ? undefined : nextStep);
	return block
		.split("\n")
		.map((line) => (line.startsWith("          ") ? line.slice(10) : line))
		.join("\n");
}

describe("check-publish-manifests", () => {
	test("keeps the nightly release manually triggerable", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");

		expect(workflow).toContain("  workflow_dispatch:\n  push:");
	});

	test("keeps threaded extraction worker in standalone daemon and meta-package builds", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");

		expect(daemonBuild).toContain('entrypoint: "./src/pipeline/extraction-thread.ts"');
		expect(daemonBuild).toContain('outfile: "./dist/extraction-thread.js"');
		expect(metaPackageBuild).toContain('entrypoint: "../../platform/daemon/src/pipeline/extraction-thread.ts"');
		expect(metaPackageBuild).toContain('outfile: "./dist/extraction-thread.js"');
	});

	test("keeps Node daemon build banner from colliding with esbuild require helper", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");
		const banner = "const require = __createRequire(import.meta.url);";

		expect(daemonBuild).toContain(banner);
		expect(metaPackageBuild).toContain(banner);
		expect(daemonBuild).not.toContain("const __require =");
		expect(metaPackageBuild).not.toContain("const __require =");
	});

	test("routes forced daemon builds through the Node/esbuild path", () => {
		const root = join(import.meta.dir, "..");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");
		const metaPackageBuild = readFileSync(join(root, "dist", "signetai", "build-daemon.ts"), "utf-8");

		for (const buildScript of [daemonBuild, metaPackageBuild]) {
			expect(buildScript).toContain('const forceNodeBuild = process.env.FORCE_NODE_BUILD === "1";');
			expect(buildScript).toContain('const isBun = typeof Bun !== "undefined" && !forceNodeBuild;');
		}
	});

	test("keeps runtime split SQLite loader ESM-safe", () => {
		const root = join(import.meta.dir, "..");
		const dbSource = readFileSync(join(root, "platform", "daemon", "src", "db.ts"), "utf-8");
		const dbAccessorSource = readFileSync(join(root, "platform", "daemon", "src", "db-accessor.ts"), "utf-8");

		for (const source of [dbSource, dbAccessorSource]) {
			expect(source).toContain('import { createRequire } from "node:module";');
			expect(source).toContain("createRequire(import.meta.url)");
			expect(source).not.toContain('await import("node:module")');
		}
		expect(dbSource).not.toContain('({ Database } = require("bun:sqlite"));');
	});

	test("installs bundle plugins under runtime/plugins", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("component_runtime_path()");
			expect(script).toContain("cleanup_legacy_plugin_paths()");
			expect(script).toContain('plugin-*) printf \'%s/runtime/plugins/%s\' "$SIGNET_INSTALL_DIR" "${name#plugin-}" ;;');
		}
	});

	test("keeps bundle manifest fallback parser scoped to first-level manifest fields", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("ignoring nested metadata");
			expect(script).toContain("components|scripts)");
			expect(script).toContain("if (in_item && item_depth == 1)");
			expect(script).toContain('collection="$(printf');
		}
	});

	test("validates archive paths from raw tar member names", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain('tar tzf "$archive"');
			expect(script).toContain('$0 ~ /[[:space:]]/');
			expect(script).toContain('$0 ~ /(^|\\/)\\.\\.($|\\/)/');
			expect(script).not.toContain("sed 's/^.* //'");
		}
	});

	test("rejects unsafe archive links before extraction", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			const linkCheck = script.indexOf("Archive contains unsafe links");
			expect(linkCheck).toBeGreaterThan(-1);
			expect(script).toContain("absolute symlink target");
			expect(script).toContain("escaping symlink target");
			expect(script).toContain("member descends through symlink");
			expect(script).toContain("hard link entry");
			expect(linkCheck).toBeLessThan(script.indexOf('tar xzf "$archive" -C "$dest"'));
		}
	});

	test("fails macOS desktop bundle builds when expected artifacts are missing", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("Electron build produced no macOS DMG");
		expect(workflow).toContain("Electron build produced no macOS zip");
		expect(workflow).toContain("npx electron-builder --mac --${{ matrix.electron_arch }} --publish never");
		expect(workflow).not.toContain("npx electron-builder --mac dmg");
		expect(workflow).not.toContain('cp release/*.dmg "$ARTIFACT_DIR/" 2>/dev/null || true');
		expect(workflow).not.toContain('cp release/*.zip "$ARTIFACT_DIR/" 2>/dev/null || true');
	});

	test("builds Rust bundle artifacts from nested workspaces", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("GitHub-hosted standard Linux arm64 runner label");
		expect(workflow).toContain("docs.github.com/actions/reference/runners/github-hosted-runners");
		expect(workflow).toContain("- runner: ubuntu-24.04-arm\n            platform: linux-arm64");
		expect(workflow).toContain('daemon_rs:\n              - "platform/daemon-rs/**"');
		expect(workflow).toContain('native:\n              - "platform/native/**"');
		expect(workflow).toContain("cargo build --release --manifest-path platform/daemon-rs/Cargo.toml");
		expect(workflow).toContain('cp "platform/daemon-rs/target/$RUST_TARGET/release/signet-daemon"');
		expect(workflow).not.toContain('cp "target/$RUST_TARGET/release/signet-daemon"');
	});

	test("runs bundle validation on pull requests without publishing releases", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("pull_request:\n    branches: [main]");
		expect(workflow).toContain('pull_request:\n    branches: [main]\n    paths:\n      - "platform/**"');
		expect(workflow).toContain("build:\n    needs: detect-changes");
		expect(workflow).toContain("permissions:\n      contents: read");
		expect(workflow).toContain("release:\n    needs: [detect-changes, build]");
		expect(workflow).toContain("github.ref == 'refs/heads/main'");
	});

	test("installs Bun before release manifest generation", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");
		const release = workflow.slice(workflow.indexOf("  release:"));

		expect(release).toContain("- uses: oven-sh/setup-bun@v2");
		expect(release.indexOf("- uses: oven-sh/setup-bun@v2")).toBeLessThan(release.indexOf("- name: Generate manifests"));
		expect(release).toContain("bun deploy/bundle/scripts/generate-manifest.ts");
	});

	test("retries transient bundle dependency install failures", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("bun install attempt ${attempt}/3");
		expect(workflow).toContain("for attempt in 1 2 3; do");
		expect(workflow).toContain("sleep $((attempt * 5))");
		expect(workflow).not.toContain("- name: Install JS dependencies\n        run: bun install");
	});

	test("pins bundled Node runtime versions in CI", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("BUNDLE_NODE_VERSION: 20.19.5");
		expect(workflow).toContain('NODE_VER="$BUNDLE_NODE_VERSION"');
		expect(workflow).toContain('NODE_TARGET="$("$ARTIFACT_DIR/signet-node-$PLATFORM/bin/node" --version | sed \'s/^v//\')"');
		expect(workflow).toContain('npm_config_target="$NODE_TARGET"');
		expect(workflow).toContain('npm_config_platform="$NPM_PLATFORM"');
		expect(workflow).toContain('npm_config_arch="$NPM_ARCH"');
		expect(workflow).not.toContain("NODE_VER=\"$(node --version | sed 's/^v//')\"");
	});

	test("verifies bundled Node runtime against upstream checksums", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("SHASUMS256.txt");
		expect(workflow).toContain('EXPECTED_SHA="$(awk -v file="$NODE_TAR"');
		expect(workflow).toContain("Node upstream checksum not found");
		expect(workflow).toContain('ACTUAL_SHA="$($SHA_CMD "/tmp/${NODE_TAR}"');
		expect(workflow).toContain("Node checksum mismatch");
		expect(workflow.indexOf("Node checksum mismatch")).toBeLessThan(
			workflow.indexOf('tar xzf "/tmp/${NODE_TAR}"'),
		);
	});

	test("packages CLI bundle with Node ESM metadata", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("bun run build:workspace-deps");
		expect(workflow).toContain("bun run build:cli");
		expect(workflow).toContain("jq '{type:\"module\", version:.version}' package.json > ./dist/package.json");
		expect(workflow).toContain('tar czf "$ARTIFACT_DIR/signet-cli.tar.gz" -C dist cli.js package.json');
		expect(workflow).not.toContain('tar czf "$ARTIFACT_DIR/signet-cli.tar.gz" -C dist cli.js\n');
	});

	test("fails Pi plugin packaging when the extension artifact is missing", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain('cp integrations/pi/extension/dist/signet-pi.mjs "$STAGE/"');
		expect(workflow).toContain('[ ! -s "$STAGE/signet-pi.mjs" ]');
		expect(workflow).toContain("Pi extension build did not produce signet-pi.mjs");
		expect(workflow).not.toContain('cp integrations/pi/extension/dist/*.mjs "$STAGE/" 2>/dev/null || true');
	});

	test("smoke-checks native bundle artifact layout before release upload", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");
		const daemonBuild = readFileSync(join(root, "platform", "daemon", "build.ts"), "utf-8");

		expect(workflow).toContain("bundle-layout-check");
		expect(workflow).toContain('tar xzf "$MERGE_DIR/signet-cli.tar.gz" -C "$CHECK_DIR/runtime/cli"');
		expect(workflow).toContain('tar xzf "$MERGE_DIR/signet-connectors.tar.gz" -C "$CHECK_DIR/runtime/connectors"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/cli/cli.js"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/cli/package.json"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/daemon-js/index.js"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/connectors/hermes-agent/hermes-plugin/__init__.py"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/connectors/hermes-agent/hermes-plugin/plugin.yaml"');
		expect(workflow).toContain("Bundle artifact layout missing");
		expect(workflow).toContain("for PLATFORM in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do");
		expect(workflow).toContain('HELPER_SCRIPT_DIR="/tmp/release-helper-scripts"');
		expect(workflow).toContain('MANIFEST_DIR="/tmp/release-manifests"');
		expect(workflow).toContain('cp "deploy/bundle/$script" "$HELPER_SCRIPT_DIR/$script"');
		expect(workflow).toContain('$SHA_CMD "$HELPER_SCRIPT_DIR/$script" > "$HELPER_SCRIPT_DIR/$script.sha256"');
		expect(workflow).toContain(
			"for component in node cli daemon-js daemon-rs dashboard connectors plugin-opencode plugin-oh-my-pi plugin-pi native skills templates; do",
		);
		expect(workflow).toContain("Merged manifest for $PLATFORM missing expected component: $component");
		expect(workflow).toContain(".components[$component].url and .components[$component].sha256");
		expect(workflow).toContain("for script in install.sh update.sh uninstall.sh; do");
		expect(workflow).toContain('cp "$HELPER_SCRIPT_DIR/$script" "$HELPER_SCRIPT_DIR/$script.sha256" "$MERGE_DIR/"');
		expect(workflow).toContain(".scripts[$script].url and .scripts[$script].sha256");
		expect(workflow).toContain("Merged manifest for $PLATFORM missing expected helper script: $script");
		expect(workflow).toContain('cp "$MERGE_DIR/manifest-$PLATFORM.json" "$MANIFEST_DIR/"');
		expect(daemonBuild).toContain('{ entrypoint: "./src/daemon.ts", outfile: "./dist/daemon.js" }');
		expect(daemonBuild).toContain('{ entrypoint: "./src/index.ts", outfile: "./dist/index.js" }');
		expect(workflow).toContain('SIGNET_DAEMON_SMOKE_MODULE="$CHECK_DIR/runtime/daemon-js/index.js"');
		expect(workflow).toContain('"$CHECK_DIR/runtime/node/bin/node"');
		expect(workflow).toContain("--input-type=module");
		expect(workflow).toContain("-e 'await import(process.env.SIGNET_DAEMON_SMOKE_MODULE)'");
		expect(workflow).toContain('if [ "$PLATFORM" = "linux-x64" ]; then');
		expect(workflow).toContain("Runtime smoke can only execute the assembled bundle matching the release runner OS/arch");
		expect(workflow).toContain('} > "$CHECK_DIR/bin/signet"');
		expect(workflow).toContain('export NODE_PATH="$SIGNET_DIR/runtime/daemon-js/node_modules"');
		expect(workflow).toContain('"$CHECK_DIR/bin/signet" setup --help >/dev/null');
		expect(workflow).toContain('"$CHECK_DIR/bin/signet" dashboard --help >/dev/null');
		expect(workflow).toContain('"$CHECK_DIR/bin/signet" daemon --help >/dev/null');
		expect(workflow).toContain('"$CHECK_DIR/bin/signet" daemon status --path "$CHECK_DIR/smoke-agents" --json >/dev/null');
		expect(workflow).toContain('"$CHECK_DIR/bin/signet" mcp --help >/dev/null');
		expect(workflow).toContain('SMOKE_PORT="$(python3 -c');
		expect(workflow).toContain('SIGNET_DAEMON_ENTRYPOINT="1"');
		expect(workflow).toContain('} > "$CHECK_DIR/smoke-agents/agent.yaml"');
		expect(workflow).toContain("printf '%s\\n' 'embedding:'");
		expect(workflow).toContain("printf '%s\\n' '  provider: none'");
		expect(workflow).toContain("printf '%s\\n' '  pipelineV2:'");
		expect(workflow).toContain("printf '%s\\n' '    paused: true'");
		expect(workflow).toContain("printf '%s\\n' '    embeddingTracker:'");
		expect(workflow).not.toContain("<<'YAML'");
		expect(workflow).toContain('"$CHECK_DIR/runtime/node/bin/node" "$CHECK_DIR/runtime/daemon-js/daemon.js" > "$SMOKE_LOG" 2>&1 &');
		expect(workflow).toContain('curl -fsS "http://127.0.0.1:${SMOKE_PORT}/health"');
		expect(workflow).toContain("Bundled Node daemon did not become healthy");
		expect(workflow).toContain('trap \'if [ -n "${SMOKE_PID:-}" ]; then kill "$SMOKE_PID"');
		expect(workflow).not.toContain('if [ "$PLATFORM" = "linux-x64" ]; then\n              # Import the daemon package API entrypoint');
		expect(workflow).not.toContain("import(process.env.SIGNET_DAEMON_SMOKE)");
	});

	test("keeps bundle release manifest shell script syntactically valid", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");
		const script = extractWorkflowRunBlock(workflow, "Generate manifests");
		const dir = mkdtempSync(join(tmpdir(), "signet-bundle-workflow-"));
		const file = join(dir, "generate-manifests.sh");

		try {
			writeFileSync(file, script);
			execFileSync("bash", ["-n", file], { stdio: "pipe" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails release staging when duplicate asset names have different content", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("De-duplicate and stage release assets");
		expect(workflow).toContain("find /tmp/all-artifacts /tmp/release-helper-scripts /tmp/release-manifests -type f");
		expect(workflow).toContain("-name '*.sh'");
		expect(workflow).toContain("-name '*.sh.sha256'");
		expect(workflow).toContain('existing="$(sha256sum "/tmp/release-staging/$base"');
		expect(workflow).toContain('current="$(sha256sum "$f"');
		expect(workflow).toContain("::error::Duplicate asset $base with different content");
		expect(workflow).toContain("exit 1");
		expect(workflow).not.toContain("::warning::Duplicate asset $base with different content");
	});

	test("uploads staged desktop release assets", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain(
			"for pattern in '*.tar.gz' '*.sha256' '*.sh.sha256' '*.dmg' '*.zip' '*.sh' 'manifest-*.json'; do",
		);
		expect(workflow).toContain('find /tmp/release-staging -type f -name "$pattern"');
		expect(workflow).toContain('gh release upload "$TAG" "$f" --repo "$REPO" --clobber');
		expect(workflow).toContain('for script in install.sh update.sh uninstall.sh; do');
		expect(workflow).toContain('"/tmp/release-staging/$script.sha256"');
		expect(workflow).toContain("Missing staged helper asset");
		expect(workflow).toContain('gh release upload "$TAG" "$helper_asset" --repo "$REPO" --clobber');
		expect(workflow).toContain("Stable manifest pointer for the latest native bundle");
		expect(workflow).toContain("bundle-latest is the stable pointer");
		expect(workflow).toContain('find /tmp/release-staging -type f -name \'manifest-*.json\'');
		expect(workflow).not.toContain("gh release upload \"$TAG\" deploy/bundle/install.sh");
	});

	test("delegates updater reinstall without sharing the install lock trap", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		expect(updater).toContain('INSTALLER="$TMPDIR/install.sh"');
		expect(updater).toContain("trap 'rm -rf \"$TMPDIR\"' EXIT");
		expect(updater).toContain("LOCK_ACQUIRED=0");
		expect(updater).toContain('SIGNET_INSTALL_DIR="$SIGNET_INSTALL_DIR" bash "$INSTALLER"');
		expect(updater).not.toContain('curl -fsSL "${DOWNLOAD_BASE}/install.sh" |');
	});

	test("cleans install and update locks only after acquiring ownership", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("LOCK_ACQUIRED=0");
			expect(script).toContain('if [ "$LOCK_ACQUIRED" = "1" ]; then');
			expect(script).toContain("LOCK_ACQUIRED=1");
			expect(script).toContain('if mkdir "$LOCKFILE" 2>/dev/null; then');
			expect(script).toContain('LOCK_PID="$(cat "$LOCKFILE/pid" 2>/dev/null || true)"');
			expect(script).toContain('kill -0 "$LOCK_PID"');
			expect(script).toContain("pid ${LOCK_PID:-unknown} not running");
			expect(script).not.toContain('if [ "$LOCK_AGE" -lt 300 ]; then');
			expect(script).not.toContain('trap \'rm -rf "$TMPDIR"; rm -rf "$LOCKFILE"\' EXIT');
		}
	});

	test("rejects dangerous install dirs before lock creation", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			const validation = script.indexOf('validate_install_dir "$SIGNET_INSTALL_DIR"');
			const mkdirInstallDir = script.indexOf('mkdir -p "$SIGNET_INSTALL_DIR"');
			expect(script).toContain("normalize_path_for_guard()");
			expect(script).toContain('*) absolute="$(pwd -P)/$path" ;;');
			expect(script).toContain('read -r -a parts <<< "$absolute"');
			expect(script).toContain('if [ -d "$next" ]; then');
			expect(script).toContain('next="$(cd "$next" 2>/dev/null && pwd -P || printf');
			expect(script).toContain('SIGNET_INSTALL_DIR="$(validate_install_dir "$SIGNET_INSTALL_DIR")"');
			expect(script).toContain("Install dir is a dangerous path");
			expect(script).toContain('[ -z "$install_dir" ]');
			expect(script).toContain('[ "$normalized_dir" = "/" ]');
			expect(script).toContain('[ "$normalized_dir" = "$normalized_home" ]');
			expect(script).toContain("Install dir contains shell-significant characters");
			expect(script).toContain("dollar signs, backticks, backslashes, or newlines");
			expect(script).toContain("$'\\n'");
			expect(validation).toBeGreaterThan(-1);
			expect(validation).toBeLessThan(mkdirInstallDir);
		}
	});

	test("updater rejects unsupported platforms before fetching manifests", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");
		const platformDetection = updater.indexOf('PLATFORM="$(detect_platform)"');
		const manifestPath = updater.indexOf('REMOTE_MANIFEST="$TMPDIR/manifest-latest.json"');

		expect(updater).toContain("Unsupported platform:");
		expect(updater).toContain("Signet requires macOS (ARM64/x64) or Linux (ARM64/x64)");
		expect(updater).not.toContain('*) echo "unknown" ;;');
		expect(platformDetection).toBeGreaterThan(-1);
		expect(manifestPath).toBeGreaterThan(-1);
		expect(platformDetection).toBeLessThan(manifestPath);
	});

	test("normalizes uninstaller dangerous path guards before deletion", () => {
		const root = join(import.meta.dir, "..");
		const uninstaller = readFileSync(join(root, "deploy", "bundle", "uninstall.sh"), "utf-8");
		const validation = uninstaller.indexOf('validate_safe_dir "install dir" "$SIGNET_INSTALL_DIR"');
		const stopDaemon = uninstaller.indexOf("# Stop daemon if running");
		const removal = uninstaller.indexOf('rm -rf "$SIGNET_INSTALL_DIR"');

		expect(uninstaller).toContain("normalize_path_for_guard()");
		expect(uninstaller).toContain('*) absolute="$(pwd -P)/$path" ;;');
		expect(uninstaller).toContain('read -r -a parts <<< "$absolute"');
		expect(uninstaller).toContain('if [ -d "$next" ]; then');
		expect(uninstaller).toContain('next="$(cd "$next" 2>/dev/null && pwd -P || printf');
		expect(uninstaller).toContain("validate_safe_dir()");
		expect(uninstaller).toContain('[ "$normalized_value" = "/" ]');
		expect(uninstaller).toContain('[ "$normalized_value" = "$normalized_home" ]');
		expect(uninstaller).toContain('SIGNET_INSTALL_DIR="$(validate_safe_dir "install dir" "$SIGNET_INSTALL_DIR")"');
		expect(uninstaller).toContain('AGENTS_DIR="$(validate_safe_dir "agents dir" "$AGENTS_DIR")"');
		expect(uninstaller).toContain("no manifest.json");
		expect(uninstaller).not.toContain('[ ! -d "$SIGNET_INSTALL_DIR/bin" ]');
		expect(validation).toBeGreaterThan(-1);
		expect(validation).toBeLessThan(stopDaemon);
		expect(validation).toBeLessThan(removal);
	});

	test("manages shell PATH entries by exact install bin path", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const uninstaller = readFileSync(join(root, "deploy", "bundle", "uninstall.sh"), "utf-8");

		expect(installer).toContain('grep -Fq "export PATH=\\"$bindir:\\$PATH\\""');
		expect(installer).toContain("# Signet PATH");
		expect(installer).toContain("# End Signet PATH");
		expect(installer).not.toContain("grep -q 'signet/bin'");

		expect(uninstaller).toContain("remove_path_from_rc()");
		expect(uninstaller).toContain('grep -Fq "export PATH=\\"$SIGNET_INSTALL_DIR/bin:\\$PATH\\""');
		expect(uninstaller).toContain('awk -v bindir="$bindir"');
		expect(uninstaller).toContain('$0 == "# Signet PATH"');
		expect(uninstaller).toContain('$0 == "# Signet"');
		expect(uninstaller).not.toContain("sed -i.bak");
		expect(uninstaller).not.toContain("signet\\/bin");
	});

	test("promotes installer manifest only after required install steps", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const manifestCopy = installer.indexOf('cp "${' + 'tmpdir}/manifest.json" "$SIGNET_INSTALL_DIR/manifest.json"');

		expect(manifestCopy).toBeGreaterThan(installer.indexOf("verify_entrypoints"));
		expect(manifestCopy).toBeGreaterThan(installer.indexOf("generate_wrappers"));
		expect(manifestCopy).toBeGreaterThan(installer.indexOf("setup_path"));
		expect(manifestCopy).toBeGreaterThan(installer.indexOf("signet daemon restart --no-sync"));
		expect(manifestCopy).toBeLessThan(installer.indexOf("Signet v${VERSION_VAL} installed"));
	});

	test("treats broken symlinks as existing component paths during promotion and removal", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("path_exists_or_symlink()");
			expect(script).toContain('[ -e "$1" ] || [ -L "$1" ]');
			expect(script).toContain('if path_exists_or_symlink "$DEST"; then mv "$DEST" "$OLD"; fi');
		}
		for (const script of [installer, updater]) {
			expect(script).toContain('if path_exists_or_symlink "$OLD"; then');
			expect(script).toContain('warn "Cleaning stale backup: $(basename "$OLD")"');
			expect(script).toContain('rm -rf "$OLD"');
		}
		expect(installer).toContain('if path_exists_or_symlink "$PDEST"; then rm -rf "$PDEST"; fi');
		expect(installer).toContain('if path_exists_or_symlink "$POLD"; then mv "$POLD" "$PDEST"; fi');
		expect(updater).toContain('if path_exists_or_symlink "$OLD2"; then mv "$OLD2" "$DEST2"; fi');
		expect(updater).toContain('if path_exists_or_symlink "$DEST"; then\n    rm -rf "$DEST" "${DEST}.old"');
	});

	test("restarts an existing bundled daemon before promoting the install manifest", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const restart = installer.indexOf("signet daemon restart --no-sync");
		const startFallback = installer.indexOf("signet daemon start");
		const manifestCopy = installer.indexOf('cp "${' + 'tmpdir}/manifest.json" "$SIGNET_INSTALL_DIR/manifest.json"');

		expect(installer).toContain('if [ "${SIGNET_NO_START:-}" != "1" ]; then');
		expect(installer).toContain('warn "Daemon restart failed');
		expect(restart).toBeGreaterThan(installer.indexOf("signet setup --non-interactive"));
		expect(startFallback).toBeGreaterThan(restart);
		expect(manifestCopy).toBeGreaterThan(restart);
	});

	test("requires every expected bundle component during install", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");

		expect(installer).toContain(
			'REQUIRED_COMPONENTS="node cli daemon-js daemon-rs dashboard connectors plugin-opencode plugin-oh-my-pi plugin-pi native skills templates"',
		);
	});

	test("documents pipeline-side installer environment options", () => {
		const root = join(import.meta.dir, "..");
		const readme = readFileSync(join(root, "deploy", "bundle", "README.md"), "utf-8");

		expect(readme).toContain("curl -fsSL https://signetai.sh/install.sh | SIGNET_INSTALL_DIR=/opt/signet bash");
		expect(readme).toContain("curl -fsSL https://signetai.sh/install.sh | SIGNET_NO_PATH=1 bash");
		expect(readme).not.toContain("SIGNET_INSTALL_DIR=/opt/signet curl");
		expect(readme).not.toContain("SIGNET_NO_PATH=1 curl");
	});

	test("refreshes bundle wrappers and helper scripts during updates", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");
		const refresh = updater.lastIndexOf("refresh_wrappers");
		const manifestCopy = updater.indexOf('cp "$REMOTE_MANIFEST" "$LOCAL_MANIFEST"');

		expect(updater).toContain("refresh_wrappers()");
		expect(updater).toContain('download_verified_script "uninstall.sh" "${bindir}/_uninstall.sh"');
		expect(updater).toContain("Could not refresh verified uninstaller helper");
		expect(updater).toContain('download_verified_script "update.sh" "${bindir}/_update.sh"');
		expect(updater).toContain("Could not refresh verified updater helper");
		expect(refresh).toBeGreaterThan(updater.indexOf('if [ "$FAILED" -gt 0 ]'));
		expect(refresh).toBeLessThan(manifestCopy);
	});

	test("exposes bundled dashboard skills and templates through wrappers", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");
		const cli = readFileSync(join(root, "surfaces", "cli", "src", "cli.ts"), "utf-8");
		const dashboardRoutes = readFileSync(
			join(root, "platform", "daemon", "src", "routes", "dashboard.ts"),
			"utf-8",
		);

		for (const script of [installer, updater]) {
			expect(script.match(/SIGNET_DASHBOARD_DIR="\$SIGNET_DIR\/runtime\/dashboard"/g)?.length).toBe(3);
			expect(script.match(/SIGNET_SKILLS_SOURCE="\$SIGNET_DIR\/runtime\/skills"/g)?.length).toBe(3);
			expect(script.match(/SIGNET_TEMPLATES_DIR="\$SIGNET_DIR\/runtime\/templates"/g)?.length).toBe(3);
		}
		expect(cli).toContain("process.env.SIGNET_TEMPLATES_DIR");
		expect(cli).toContain("process.env.SIGNET_SKILLS_SOURCE");
		expect(dashboardRoutes).toContain("process.env.SIGNET_DASHBOARD_DIR");
		expect(dashboardRoutes).toContain("...(envDashboardDir ? [envDashboardDir] : [])");
	});

	test("does not advertise unsupported versioned bundle installs", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");

		expect(installer).toContain('if [ "$SIGNET_VERSION" != "latest" ]; then');
		expect(installer).toContain("SIGNET_VERSION is not supported by the native bundle installer yet");
		expect(installer).not.toContain("SIGNET_VERSION      — version tag");
	});

	test("keeps bundle downloads pinned to expected release assets", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("is_expected_asset_url()");
			expect(script).toContain("RELEASE_DOWNLOAD_PREFIX=");
			expect(script).toContain("is_expected_release_url()");
			expect(script).toContain('"$RELEASE_DOWNLOAD_PREFIX"/*');
			expect(script).toContain("bundle-*)");
			expect(script).toContain('[ "$asset" = "$filename" ]');
			expect(script).toContain('signet-"$name".tar.gz|signet-"$name"-"$PLATFORM".tar.gz');
			expect(script).toContain("outside expected release assets");
		}
	});

	test("verifies downloaded helper scripts against the manifest", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");
		const scriptInterpolation = "$" + "{script}";

		for (const script of [installer, updater]) {
			expect(script).toContain("is_expected_script_url()");
			expect(script).toContain('is_expected_release_url "$url" "$filename" || return 1');
			expect(script).toContain('filename="$(basename "$url")"');
			expect(script).toContain(`url="$(get_manifest_value ".scripts.\\"${scriptInterpolation}\\".url`);
			expect(script).toContain(`sha="$(get_manifest_value ".scripts.\\"${scriptInterpolation}\\".sha256`);
			expect(script).toContain("components|scripts)");
			expect(script).toContain("Checksum mismatch for helper script");
			expect(script).toContain("outside expected release assets");
			expect(script).not.toContain('"$DOWNLOAD_BASE/$script"');
			expect(script).not.toContain('${DOWNLOAD_BASE}/uninstall.sh" -o "${bindir}/_uninstall.sh');
			expect(script).not.toContain('${DOWNLOAD_BASE}/update.sh" -o "${bindir}/_update.sh');
		}
		expect(updater).toContain('download_verified_script "install.sh" "$INSTALLER"');
		expect(updater).toContain("Dependency-free manifest lookup for the no-jq/no-node reinstall path");
		expect(updater).toContain("first-level fields under .components and .scripts");
	});

	test("installer requires checksum tooling before downloads", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const checksumFailure = installer.indexOf("No checksum tool available");
		const downloadBase = installer.indexOf("DOWNLOAD_BASE=");

		expect(installer).toContain('err "No checksum tool available');
		expect(installer).toContain("if [ -z \"$SHA256_CMD\" ]; then return 1; fi");
		expect(installer).not.toContain("checksums will not be verified");
		expect(checksumFailure).toBeGreaterThan(-1);
		expect(checksumFailure).toBeLessThan(downloadBase);
	});

	test("removes obsolete optional components without dropping bundle-required components", () => {
		const root = join(import.meta.dir, "..");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		expect(updater).toContain(
			'REQUIRED_COMPONENTS="node cli daemon-js daemon-rs dashboard connectors plugin-opencode plugin-oh-my-pi plugin-pi native skills templates"',
		);
		expect(updater).toContain("is_required_component()");
		expect(updater).toContain("has_manifest_key()");
		expect(updater).toContain('printf \'%s\\n\' "$keys" | grep -Fx -- "$comp"');
		expect(updater).toContain("collect_obsolete_components()");
		expect(updater).toContain("Remote manifest is missing required installed component");
		expect(updater).toContain("Remote manifest no longer includes optional component");
		expect(updater).toContain("removing it during this update\" >&2");
		expect(updater).toContain('OBSOLETE_COMPONENTS="$(collect_obsolete_components "$REMOTE_KEYS")"');
		expect(updater).toContain("for comp in $OBSOLETE_COMPONENTS; do");
		expect(updater).toContain('if path_exists_or_symlink "$DEST"; then');
		expect(updater).toContain('rm -rf "$DEST" "${DEST}.old"');
		expect(updater).toContain("obsolete component(s) removed");
		expect(updater).not.toContain("refusing update without explicit obsolete marker");
	});

	test("documents daemon-js as platform-specific", () => {
		const root = join(import.meta.dir, "..");
		const readme = readFileSync(join(root, "deploy", "bundle", "README.md"), "utf-8");

		expect(readme).toContain(
			"| `daemon-js` | Daemon JS bundle with Node runtime dependencies, ONNX Runtime, and sqlite-vec | Yes |",
		);
		expect(readme).not.toContain("| `daemon-js` | Daemon JS bundle | No |");
		expect(readme).not.toContain("| `onnxruntime` |");
		expect(readme).not.toContain("| `sqlite-vec` |");
	});

	test("keeps manifest node fallback free of generated lookup code", () => {
		const root = join(import.meta.dir, "..");
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("process.argv.slice(1)");
			expect(script).not.toContain("const parts='${key}'");
		}
		expect(updater).toContain("validate_component_name()");
		expect(updater).toContain("Manifest contains invalid component name");
		expect(updater).toContain("^[A-Za-z0-9_-]+$");
	});

	test("writes real bundle artifact sizes into manifests", () => {
		const root = join(import.meta.dir, "..");
		const generator = readFileSync(join(root, "deploy", "bundle", "scripts", "generate-manifest.ts"), "utf-8");

		expect(generator).toContain("statSync");
		expect(generator).toContain("size: statSync(join(artifactDir, file)).size");
		expect(generator).toContain('const HELPER_SCRIPTS = ["install.sh", "update.sh", "uninstall.sh"]');
		expect(generator).toContain("Missing checksum: ${script}.sha256");
		expect(generator).toContain("scripts[script] =");
		expect(generator).not.toContain("size: 0");
	});

	test("keeps Hermes plugin assets in the signetai publish package", () => {
		const root = join(import.meta.dir, "..");
		const manifest = JSON.parse(readFileSync(join(root, "dist", "signetai", "package.json"), "utf-8")) as {
			files?: unknown;
			scripts?: Record<string, string>;
		};

		expect(manifest.files).toContain("hermes-plugin");
		expect(manifest.scripts?.["copy:hermes-plugin"]).toContain(
			"../../integrations/hermes-agent/connector/hermes-plugin",
		);
		expect(manifest.scripts?.prebuild).toContain("copy:hermes-plugin");
		expect(existsSync(join(root, "integrations", "hermes-agent", "connector", "hermes-plugin", "__init__.py"))).toBe(
			true,
		);
	});

	test("treats manifests with publishConfig.access public as publishable", () => {
		expect(
			isPublishableWorkspacePackage({
				name: "signetai",
				publishConfig: { access: "public" },
			}),
		).toBe(true);
	});

	test("discovers publishable manifest targets from workspace files", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			const connectorDir = join(root, "integrations", "pi", "connector");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(adapterDir, { recursive: true });
			mkdirSync(connectorDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const adapterFile = join(adapterDir, "package.json");
			const connectorFile = join(connectorDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				publishConfig: { access: "public" },
			});
			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				publishConfig: { access: "public" },
			});
			writeJson(connectorFile, {
				name: "@signet/connector-pi",
			});

			expect(listPublishableManifestTargets([signetaiFile, adapterFile, connectorFile])).toEqual([
				signetaiFile,
				adapterFile,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags runtime dependencies on unpublished workspace packages", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const connectorPiDir = join(root, "integrations", "pi", "connector");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(connectorPiDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const connectorPiFile = join(connectorPiDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				dependencies: {
					"@signet/connector-pi": "1.2.3",
				},
			});
			writeJson(connectorPiFile, {
				name: "@signet/connector-pi",
				version: "1.2.3",
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile, connectorPiFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(1);
			expect(issues[0]?.reason).toContain("not published");
			expect(issues[0]?.dep).toBe("@signet/connector-pi");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags workspace protocol in runtime dependency fields", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			mkdirSync(signetaiDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				dependencies: {
					"@signet/connector-pi": "workspace:*",
				},
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(1);
			expect(issues[0]?.reason).toContain("workspace protocol");
			expect(issues[0]?.field).toBe("dependencies");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps bundled Signet internals out of the OpenClaw adapter runtime manifest", () => {
		const root = join(import.meta.dir, "..");
		const rootPackageFile = join(root, "package.json");
		const adapterFile = join(root, "integrations", "openclaw", "memory-adapter", "package.json");
		const sdkFile = join(root, "libs", "sdk", "package.json");
		const coreFile = join(root, "platform", "core", "package.json");

		const rootPackage = JSON.parse(readFileSync(rootPackageFile, "utf-8")) as {
			devDependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		const adapter = JSON.parse(readFileSync(adapterFile, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
		};

		expect(rootPackage.devDependencies?.["@signet/sdk"]).toBe("workspace:*");
		expect(rootPackage.scripts?.["build:deps"]).toStartWith("bun run --filter '@signet/sdk' build && ");
		expect(adapter.dependencies?.["@signet/sdk"]).toBeUndefined();
		expect(adapter.devDependencies?.["@signet/sdk"]).toBeDefined();
		expect(adapter.peerDependencies?.openclaw).toBe(">=2026.5.22");
		expect(adapter.peerDependenciesMeta?.openclaw?.optional).toBe(true);

		const workspacePackages = collectWorkspacePackages([adapterFile, sdkFile, coreFile]);

		expect(collectManifestIssues([adapterFile], workspacePackages)).toHaveLength(0);

		const releaseRewrittenAdapterDir = mkdtempSync(join(tmpdir(), "signet-openclaw-release-manifest-"));
		try {
			const releaseRewrittenAdapterFile = join(releaseRewrittenAdapterDir, "package.json");
			writeJson(releaseRewrittenAdapterFile, {
				...JSON.parse(readFileSync(adapterFile, "utf-8")),
				version: "1.2.3",
				devDependencies: {
					...adapter.devDependencies,
					"@signet/core": "1.2.3",
					"@signet/sdk": "1.2.3",
				},
			});

			expect(collectManifestIssues([releaseRewrittenAdapterFile], workspacePackages)).toHaveLength(0);
		} finally {
			rmSync(releaseRewrittenAdapterDir, { recursive: true, force: true });
		}
	});

	test("allows runtime dependencies on publishable workspace packages", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const signetaiDir = join(root, "dist", "signetai");
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			mkdirSync(signetaiDir, { recursive: true });
			mkdirSync(adapterDir, { recursive: true });

			const signetaiFile = join(signetaiDir, "package.json");
			const adapterFile = join(adapterDir, "package.json");

			writeJson(signetaiFile, {
				name: "signetai",
				version: "1.2.3",
				publishConfig: { access: "public" },
				dependencies: {
					"@signetai/signet-memory-openclaw": "1.2.3",
				},
			});
			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				version: "1.2.3",
				publishConfig: { access: "public" },
			});

			const workspacePackages = collectWorkspacePackages([signetaiFile, adapterFile]);
			const issues = collectManifestIssues([signetaiFile], workspacePackages);

			expect(issues).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ignores devDependencies on workspace packages for publish checks", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-publish-manifests-"));
		try {
			const adapterDir = join(root, "integrations", "openclaw", "memory-adapter");
			const coreDir = join(root, "platform", "core");
			mkdirSync(adapterDir, { recursive: true });
			mkdirSync(coreDir, { recursive: true });

			const adapterFile = join(adapterDir, "package.json");
			const coreFile = join(coreDir, "package.json");

			writeJson(adapterFile, {
				name: "@signetai/signet-memory-openclaw",
				version: "1.2.3",
				publishConfig: { access: "public" },
				dependencies: {
					"@sinclair/typebox": "0.34.47",
				},
				devDependencies: {
					"@signet/core": "workspace:*",
				},
			});
			writeJson(coreFile, {
				name: "@signet/core",
				version: "1.2.3",
			});

			const workspacePackages = collectWorkspacePackages([adapterFile, coreFile]);
			const issues = collectManifestIssues([adapterFile], workspacePackages);

			expect(issues).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
