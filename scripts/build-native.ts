/** Build and stage the production Rust daemon for this platform/architecture. */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "platform", "native");
const manifest = join(root, "platform", "rust-daemon", "Cargo.toml");
const platformKey = `${platform()}-${arch()}`;
const targets: Record<string, string> = {
	"linux-x64": "x86_64-unknown-linux-gnu",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
	"win32-x64": "x86_64-pc-windows-msvc",
};
const target = targets[platformKey];
if (!target) throw new Error(`Unsupported native target ${platformKey}`);
const exe = platform() === "win32" ? "signet-daemon.exe" : "signet-daemon";
const mcp = platform() === "win32" ? "signet-mcp.exe" : "signet-mcp";
const dashboard = join(root, "surfaces", "dashboard", "build");
const runtime = join(root, "dist", "signetai", "runtime", "rust-daemon");
const stage = join(runtime, platformKey);
const source = join(root, "platform", "rust-daemon", "target", target, "release", exe);
const sourceMcp = join(root, "platform", "rust-daemon", "target", target, "release", mcp);

function fail(message: string): never {
	throw new Error(`[signet] ${message}`);
}
function executable(path: string): void {
	if (!existsSync(path)) fail(`required artifact is missing: ${path}`);
	if (platform() !== "win32") {
		try {
			execFileSync("test", ["-x", path]);
		} catch {
			fail(`artifact is not executable: ${path}`);
		}
	}
}
function revision(): string {
	return process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

if (process.env.SIGNET_SKIP_NATIVE_BUILD === "1") {
	console.log("[signet] skipping native build (SIGNET_SKIP_NATIVE_BUILD=1)");
	process.exit(0);
}
if (!existsSync(nativeDir) || !existsSync(manifest)) fail("native Rust build inputs are missing");
if (!existsSync(join(dashboard, "index.html"))) fail(`dashboard build is missing: ${join(dashboard, "index.html")}`);
const locator = platform() === "win32" ? "where" : "which";
let cargoLocated = false;
try {
	execFileSync(locator, ["cargo"], { stdio: "ignore", windowsHide: true });
	cargoLocated = true;
} catch {
	// Some minimal images do not ship which/where; direct probing remains authoritative.
}
if (cargoLocated) {
	try {
		execFileSync("cargo", ["--version"], { stdio: "ignore", windowsHide: true });
	} catch {
		fail("native build failed (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	}
} else {
	try {
		execFileSync("cargo", ["--version"], { stdio: "ignore", windowsHide: true });
	} catch {
		fail("cargo is required (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	}
}

const staging = mkdtempSync(join(root, ".signet-native-stage-"));
try {
	execFileSync("bun", ["run", "build"], { cwd: nativeDir, stdio: "inherit" });
	execFileSync("cargo", ["build", "--release", "--target", target, "--manifest-path", manifest], {
		cwd: root,
		stdio: "inherit",
	});
	executable(source);
	executable(sourceMcp);
	const stagedDir = join(staging, platformKey);
	mkdirSync(stagedDir, { recursive: true });
	cpSync(source, join(stagedDir, exe));
	cpSync(sourceMcp, join(stagedDir, mcp));
	cpSync(dashboard, join(staging, "dashboard"), { recursive: true });
	if (platform() !== "win32") {
		chmodSync(join(stagedDir, exe), 0o755);
		chmodSync(join(stagedDir, mcp), 0o755);
	}
	const checksum = createHash("sha256")
		.update(readFileSync(join(stagedDir, exe)))
		.digest("hex");
	writeFileSync(
		join(staging, "provenance.json"),
		JSON.stringify(
			{
				artifact: join(stage, exe),
				target,
				platform: platform(),
				architecture: arch(),
				sha256: checksum,
				size: readFileSync(join(stagedDir, exe)).byteLength,
				rustToolchain: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
				cargoLockSha256: createHash("sha256")
					.update(readFileSync(join(root, "platform/rust-daemon/Cargo.lock")))
					.digest("hex"),
				executableIdentity: execFileSync("file", ["-b", join(stagedDir, exe)], { encoding: "utf8" }).trim(),
				sourceRevision: revision(),
			},
			null,
			2,
		) + "\n",
	);
	rmSync(runtime, { recursive: true, force: true });
	mkdirSync(runtime, { recursive: true });
	renameSync(staging, runtime);
	console.log(`[signet] staged Rust daemon for ${target}: ${join(stage, exe)}`);
} catch (error) {
	rmSync(staging, { recursive: true, force: true });
	console.error(error instanceof Error ? error.message : error);
	console.error("[signet] native build failed (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	process.exit(1);
}
