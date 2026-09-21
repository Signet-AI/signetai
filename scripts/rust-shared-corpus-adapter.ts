#!/usr/bin/env bun
/** Execute unchanged pinned baseline tests through the Rust daemon boundary. */
import {
	existsSync,
	statSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	unlinkSync,
	realpathSync,
	openSync,
	closeSync,
} from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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
const evidenceFile = `${report}.native-evidence`;
const daemonEvidenceFile = `${report}.daemon-evidence`;
const evidenceNonce = randomUUID();
if (existsSync(evidenceFile)) unlinkSync(evidenceFile);
if (existsSync(daemonEvidenceFile)) unlinkSync(daemonEvidenceFile);
const stdoutPath = `${report}.stdout`;
const stderrPath = `${report}.stderr`;
for (const path of [stdoutPath, stderrPath]) if (existsSync(path)) unlinkSync(path);
const junitPath = `${report}.bun.xml`;
if (existsSync(junitPath)) unlinkSync(junitPath);
const stdoutFd = openSync(stdoutPath, "w");
const stderrFd = openSync(stderrPath, "w");
let child: ReturnType<typeof spawnSync> | undefined;
let spawnError: unknown;
try {
	child = spawnSync(
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
			env: {
				...process.env,
				SIGNET_RUST_DAEMON_BIN: artifact,
				SIGNET_RUST_DAEMON_EVIDENCE_FILE: daemonEvidenceFile,
				SIGNET_RUST_EVIDENCE_NONCE: evidenceNonce,
				SIGNET_RUST_CORE_DRIVER_BIN: coreDriver,
				SIGNET_RUST_CORE_EVIDENCE_FILE: evidenceFile,
			},
			stdio: ["ignore", stdoutFd, stderrFd],
		},
	);
} catch (error) {
	spawnError = error;
} finally {
	closeSync(stdoutFd);
	closeSync(stderrFd);
}
if (!child) {
	const message = spawnError instanceof Error ? spawnError.message : String(spawnError ?? "unknown spawn error");
	fail(`Rust child could not start: ${message}`);
}
const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
const daemonEvidence =
	existsSync(daemonEvidenceFile) &&
	readFileSync(daemonEvidenceFile, "utf8")
		.split(/\r?\n/)
		.some((line) => {
			try {
				const value = JSON.parse(line) as { backend?: string; binary?: string; nonce?: string };
				return value.backend === "rust-daemon" && value.binary === artifact && value.nonce === evidenceNonce;
			} catch {
				return false;
			}
		});
const coreEvidence =
	existsSync(evidenceFile) &&
	/backend=fresh-rust artifact=signet-core-test-driver process=transport/.test(readFileSync(evidenceFile, "utf8"));
const nativeEvidence = daemonEvidence || coreEvidence;
const evidence =
	stderr.trim() || stdout.trim() || `child status=${child.status ?? "null"} signal=${child.signal ?? "none"}`;
if (!existsSync(junitPath)) fail(`Rust child did not produce a JUnit report: ${evidence}`);
const reportXml = readFileSync(junitPath, "utf8");
const cases = reportXml.match(/<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
if (!cases.length) fail(`Rust child produced no real testcase identities: ${evidence}`);
const observedFiles = new Set(
	cases.map((testcase) => testcase.match(/file="([^"]*)"/)?.[1]).filter((file): file is string => Boolean(file)),
);
const missingSelected = selected.filter((path) => !observedFiles.has(path));
const unexpectedFiles = [...observedFiles].filter((path) => !selected.includes(path));
const infrastructureFailure =
	child.signal !== null ||
	child.error !== undefined ||
	!cases.length ||
	missingSelected.length > 0 ||
	unexpectedFiles.length > 0;
const failures = cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length;
writeFileSync(
	report,
	`<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" nativeEvidence="${nativeEvidence}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">${cases.join("")}</testsuite>`,
);
if (existsSync(evidenceFile)) unlinkSync(evidenceFile);
if (existsSync(daemonEvidenceFile)) unlinkSync(daemonEvidenceFile);
console.error(
	JSON.stringify({
		backend: "fresh-rust",
		artifact,
		selected,
		executed: selected,
		nativeEvidence,
		childStatus: child.status,
		childSignal: child.signal,
		infrastructureFailure,
		missingSelected,
		unexpectedFiles,
		stderr: stderr.slice(-8192),
		stdout: stdout.slice(-8192),
		stderrBytes: Buffer.byteLength(stderr),
		stdoutBytes: Buffer.byteLength(stdout),
	}),
);
process.exit(infrastructureFailure ? 2 : (child.status ?? 1));
