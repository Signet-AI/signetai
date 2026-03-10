#!/usr/bin/env node
/**
 * Signet postinstall script (CommonJS for npm compatibility)
 * Shows installation info, checks for Bun, and downloads the predictor sidecar.
 */

const { execFileSync } = require("node:child_process");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function hasBun() {
	try {
		execFileSync("bun", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function getVersion() {
	try {
		const pkg = require("../package.json");
		return pkg.version || null;
	} catch {
		return null;
	}
}

const version = getVersion();
const versionLabel = version ? ` v${version}` : "";

console.log();
console.log("━".repeat(50));
console.log();
console.log(`  ${CYAN}${BOLD}◈ Signet${RESET}${versionLabel} installed!`);
console.log(`  ${DIM}Portable AI agent identity${RESET}`);
console.log();

if (!hasBun()) {
	console.log(`  ${YELLOW}⚠ Bun not found${RESET}`);
	console.log(`  ${DIM}CLI commands work fine with Node.js:${RESET}`);
	console.log(`  ${DIM}  signet, signet status, signet recall, etc.${RESET}`);
	console.log();
	console.log(`  ${DIM}Bun is required for the daemon (signet start):${RESET}`);
	console.log(`  ${DIM}  curl -fsSL https://bun.sh/install | bash${RESET}`);
	console.log();
}

console.log(`  ${GREEN}What's new:${RESET}`);
console.log(`  ${DIM}- Knowledge graph: memories build structured understanding${RESET}`);
console.log(`  ${DIM}- Session continuity: seamless context across compactions${RESET}`);
console.log(`  ${DIM}- Constellation: entity overlay in the dashboard${RESET}`);
console.log(`  ${DIM}- Predictive scorer: ML-based memory ranking (enabled by default)${RESET}`);
console.log();
console.log(`  ${GREEN}Get started:${RESET}`);
console.log(`    ${CYAN}signet${RESET}        Interactive setup`);
console.log(`    ${CYAN}signet sync${RESET}   Fix missing files`);
console.log(`    ${CYAN}signet status${RESET} Check daemon`);
console.log(`    ${CYAN}signet dashboard${RESET}  Explore your agent`);
console.log();
console.log("━".repeat(50));
console.log();

// Download predictor sidecar binary (fail-open: daemon continues without it)
downloadPredictor().catch(() => {});

async function downloadPredictor() {
	const version = getVersion();
	if (!version) return;

	const platform = process.platform;
	// Only attempt download for the four platform/arch tuples we actually publish.
	// Anything outside this set would 404; fail open with a clear message instead.
	const supportedTuples = new Set(["linux:x64", "darwin:x64", "darwin:arm64", "win32:x64"]);
	const tuple = `${platform}:${process.arch}`;
	if (!supportedTuples.has(tuple)) {
		process.stdout.write(`  Downloading predictor sidecar... skipped (unsupported platform/arch: ${tuple})\n`);
		return;
	}
	const arch = process.arch;
	const ext = platform === "win32" ? ".exe" : "";
	const assetName = `signet-predictor-${platform}-${arch}${ext}`;
	const url = `https://github.com/Signet-AI/signetai/releases/download/v${version}/${assetName}`;
	const dest = path.join(__dirname, assetName);

	if (fs.existsSync(dest)) return; // already present

	return new Promise((resolve) => {
		process.stdout.write(`  Downloading predictor sidecar...`);

		function get(targetUrl, redirects) {
			if (redirects > 5) {
				process.stdout.write(` skipped (too many redirects)\n`);
				resolve();
				return;
			}
			const req = https.get(targetUrl, (res) => {
				if (res.statusCode === 301 || res.statusCode === 302) {
					res.resume();
					const location = res.headers.location;
					if (typeof location !== "string") {
						resolve();
						return;
					}
					get(location, redirects + 1);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					process.stdout.write(` skipped (not yet published for this version)\n`);
					resolve();
					return;
				}
				const file = fs.createWriteStream(dest);
				res.pipe(file);
				file.on("finish", () => {
					file.close();
					try {
						if (platform !== "win32") fs.chmodSync(dest, 0o755);
					} catch {
						// ignore chmod failures
					}
					process.stdout.write(` done\n`);
					resolve();
				});
				file.on("error", () => {
					fs.unlink(dest, () => {});
					process.stdout.write(` skipped (write error)\n`);
					resolve();
				});
			});
			req.setTimeout(10_000, () => {
				req.destroy(new Error("timeout"));
			});
			req.on("error", () => {
				fs.unlink(dest, () => {});
				process.stdout.write(` skipped (network unavailable)\n`);
				resolve();
			});
		}

		get(url, 0);
	});
}
