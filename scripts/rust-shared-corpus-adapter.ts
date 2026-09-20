#!/usr/bin/env bun
/** Execute unchanged pinned baseline tests through the Rust daemon boundary. */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, realpathSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const BASELINE = "11e4720c07107caf7fdd57a685eca24e8a82e654";
const FORBIDDEN = /(?:^|\/)(?:platform\/daemon-rs|platform\/rust-daemon-rs|platform\/daemon\/src\/daemon\.ts)(?:\/|$)/;
type Manifest = { baselineSha?: string; protectedCorpus?: Array<{ path: string; sha256: string }> };
const args = Bun.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
function fail(message: string, code = 2): never {
	console.error(`rust adapter: ${message}`);
	process.exit(code);
}
function required(name: string): string {
	const value = arg(name);
	if (!value) fail(`missing ${name}`);
	return value;
}
function esc(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
function readManifest(value: string): Manifest {
	try {
		return JSON.parse(value) as Manifest;
	} catch {
		if (!existsSync(value)) fail("manifest is missing or invalid");
		try {
			return JSON.parse(readFileSync(value, "utf8")) as Manifest;
		} catch {
			fail("manifest is invalid");
		}
	}
}
const artifact = resolve(required("--artifact"));
const coreDriver = resolve(required("--core-driver"));
const manifestValue = required("--manifest");
const pathsValue = required("--paths");
const report = resolve(required("--report"));
function validateElf(value: string, identity: string, label: string): void {
	if (!existsSync(value) || !statSync(value).isFile() || (statSync(value).mode & 0o111) === 0)
		fail(`${label} must be an executable file`);
	if (basename(value) !== identity) fail(`${label} identity is not ${identity}`);
	const header = readFileSync(value).subarray(0, 4);
	if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46)
		fail(`${label} is not an ELF Rust executable; JS/TS fallback is forbidden`);
}
validateElf(artifact, "signet-daemon", "daemon artifact");
validateElf(coreDriver, "signet-core-test-driver", "core driver artifact");
if (!realpathSync(coreDriver).includes("/platform/rust-core/target/"))
	fail("core driver artifact is stale or outside the fresh Rust core target");
if (!realpathSync(artifact).includes("/platform/rust-daemon/target/"))
	fail("daemon artifact is stale or outside the fresh Rust daemon target");
if (FORBIDDEN.test(coreDriver) || FORBIDDEN.test(artifact))
	fail("forbidden archived daemon/source path in execution boundary");
/* Keep the daemon checks explicit and unchanged in meaning. */
if (!existsSync(artifact) || !statSync(artifact).isFile() || (statSync(artifact).mode & 0o111) === 0)
	fail("artifact must be an executable file");
if (FORBIDDEN.test(artifact) || FORBIDDEN.test(process.cwd()))
	fail("forbidden daemon/source path in execution boundary");
const manifest = readManifest(manifestValue);
if (manifest.baselineSha !== BASELINE) fail(`manifest baseline must be ${BASELINE}`);
if (manifest.protectedCorpus?.length !== 497) fail("manifest must contain the pinned 497-path corpus");
const entries = new Map(manifest.protectedCorpus.map((entry) => [entry.path, entry.sha256]));
let paths: unknown;
try {
	paths = JSON.parse(pathsValue);
} catch {
	fail("--paths must be valid JSON");
}
if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string"))
	fail("--paths must be a non-empty JSON string array");
const selected = [...new Set(paths as string[])].sort();
for (const path of selected) if (!entries.has(path)) fail(`requested path is outside the pinned corpus: ${path}`);
mkdirSync(dirname(report), { recursive: true });
const junitPath = `${report}.bun.xml`;
if (existsSync(junitPath)) unlinkSync(junitPath);
const child = spawnSync(
	"bun",
	[
		"test",
		"--preload",
		resolve(import.meta.dir, "rust-shared-corpus-combined.preload.ts"),
		"--reporter=junit",
		`--reporter-outfile=${junitPath}`,
		...selected,
	],
	{
		cwd: process.cwd(),
		env: { ...process.env, SIGNET_RUST_DAEMON_BIN: artifact, SIGNET_RUST_CORE_DRIVER_BIN: coreDriver },
		encoding: "utf8",
	},
);
const stderr = `${child.stderr ?? ""}`;
const stdout = `${child.stdout ?? ""}`;
const daemonEvidence = /"backend"\s*:\s*"rust-daemon"/.test(stderr);
const coreEvidence = /backend=fresh-rust artifact=signet-core-test-driver/.test(stderr);
const nativeEvidence = daemonEvidence || coreEvidence;
const cases: string[] = [];
if (existsSync(junitPath)) {
	const reportXml = readFileSync(junitPath, "utf8");
	const matches = reportXml.match(/<testcase\b[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g);
	if (matches) cases.push(...matches);
}
const observedFiles = new Set(cases.flatMap((testcase) => selected.filter((path) => testcase.includes(path))));
const evidence =
	stderr.trim() || stdout.trim() || `child status=${child.status ?? "null"} signal=${child.signal ?? "none"}`;
if (!existsSync(junitPath) || !cases.length)
	cases.push(
		`<testcase classname="rust-shared-corpus-adapter" name="adapter-execution"><error message="missing JUnit report or testcases">${esc(evidence)}</error></testcase>`,
	);
if (!nativeEvidence)
	cases.push(
		`<testcase classname="rust-shared-corpus-adapter" name="native-boundary-evidence"><failure message="no observed Rust daemon launch evidence">${esc(evidence)}</failure></testcase>`,
	);
for (const path of selected)
	if (!observedFiles.has(path))
		cases.push(
			`<testcase classname="rust-shared-corpus-adapter" name="${esc(path)}"><failure message="selected source produced no observed testcase identity or runtime evidence">${esc(evidence)}</failure></testcase>`,
		);
if (child.status !== 0 || child.signal)
	cases.push(
		`<testcase classname="rust-shared-corpus-adapter" name="child-process"><failure message="child status=${esc(String(child.status))} signal=${esc(String(child.signal ?? "none"))}">${esc(evidence)}</failure></testcase>`,
	);
const failures = cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length;
writeFileSync(
	report,
	`<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">${cases.join("")}</testsuite>`,
);
console.error(
	JSON.stringify({
		backend: "fresh-rust",
		artifact,
		selected,
		executed: selected,
		nativeEvidence,
		childStatus: child.status,
		childSignal: child.signal,
		stderr,
	}),
);
process.exit(failures ? 1 : 0);
