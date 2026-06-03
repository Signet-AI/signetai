#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const repo = process.env.SIGNET_RELEASE_REPO ?? "Signet-AI/signetai";
const version = process.env.SIGNET_VERSION ?? packageJson.version;
const downloadBase =
	process.env.SIGNET_DOWNLOAD_BASE ?? `https://github.com/${repo}/releases/download/v${version}`;

function isWorkspacePackage() {
	const workspaceRoot = dirname(dirname(packageDir));
	if (basename(dirname(packageDir)) !== "dist") return false;
	try {
		const rootPackageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
		const workspaces = rootPackageJson.workspaces;
		return Array.isArray(workspaces) && workspaces.includes("dist/*");
	} catch {
		return false;
	}
}

if (process.env.SIGNET_SKIP_NATIVE_POSTINSTALL === "1" || isWorkspacePackage()) {
	console.log("Skipping Signet native binary download in workspace install.");
	process.exit(0);
}

function platformKey() {
	const os =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "linux"
				? "linux"
				: process.platform === "win32"
					? "win32"
					: null;
	const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
	if (!os || !arch) {
		throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
	}
	return `${os}-${arch}`;
}

function request(url, redirectCount = 0) {
	return new Promise((resolve, reject) => {
		const get = url.startsWith("http:") ? httpGet : url.startsWith("https:") ? httpsGet : null;
		if (!get) {
			reject(new Error(`Unsupported download URL: ${url}`));
			return;
		}
		const req = get(url, (res) => {
			const location = res.headers.location;
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
				res.resume();
				if (redirectCount >= 5) {
					reject(new Error(`Too many redirects while downloading ${url}`));
					return;
				}
				resolve(request(new URL(location, url).toString(), redirectCount + 1));
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`Download failed for ${url}: HTTP ${res.statusCode}`));
				return;
			}
			resolve(res);
		});
		req.on("error", reject);
	});
}

async function downloadText(url) {
	const res = await request(url);
	const chunks = [];
	for await (const chunk of res) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function downloadFile(url, path) {
	const res = await request(url);
	await new Promise((resolve, reject) => {
		const out = createWriteStream(path, { mode: 0o755 });
		res.pipe(out);
		out.on("finish", resolve);
		out.on("error", reject);
	});
}

async function main() {
	const platform = platformKey();
	const manifest = JSON.parse(await downloadText(`${downloadBase}/native-manifest.json`));
	const asset = manifest.assets?.find((candidate) => candidate.platform === platform);
	if (!asset?.name || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
		throw new Error(`No Signet native binary found for ${platform}`);
	}

	const installDir = join(packageDir, "native");
	mkdirSync(installDir, { recursive: true });
	const tempDir = await mkdtemp(join(tmpdir(), "signet-native-install-"));
	const tempPath = join(tempDir, basename(asset.name));
	const finalPath = join(installDir, process.platform === "win32" ? "signet.exe" : "signet");

	try {
		await downloadFile(`${downloadBase}/${asset.name}`, tempPath);
		const actual = createHash("sha256").update(readFileSync(tempPath)).digest("hex");
		if (actual !== asset.sha256) {
			throw new Error(`Checksum mismatch for ${asset.name}`);
		}
		if (process.platform !== "win32") {
			await chmod(tempPath, 0o755);
		}
		renameSync(tempPath, finalPath);
		console.log(`Installed Signet native binary for ${platform}`);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(`Signet native install failed: ${err.message}`);
	process.exit(1);
});
