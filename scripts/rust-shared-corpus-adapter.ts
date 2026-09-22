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
import { resolve, basename, dirname, isAbsolute, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildExecutionManifest, currentManifest } from "./shared-corpus-runner";
import { validateRustDaemonArtifact } from "./rust-shared-corpus-artifact";
import { wrapRustJUnitReport } from "./rust-shared-corpus-report";

const FORBIDDEN = /(?:^|\/)(?:platform\/daemon-rs|platform\/rust-daemon-rs|platform\/daemon\/src\/daemon\.ts)(?:\/|$)/;
const isForbiddenPath = (path: string) => FORBIDDEN.test(path.replaceAll("\\", "/"));
const isFreshTargetArtifact = (path: string, crate: string) => {
	const checkout = realpathSync(process.cwd());
	const artifact = realpathSync(path);
	const relativeArtifact = relative(checkout, artifact);
	const targetPrefix = ["platform", crate, "target"].join(sep) + sep;
	return (
		!isAbsolute(relativeArtifact) &&
		!relativeArtifact.startsWith(`..${sep}`) &&
		relativeArtifact.startsWith(targetPrefix)
	);
};
type Manifest = {
	baselineSha?: string;
	packageJsonSha256?: string;
	roots?: string[];
	filters?: string[];
	excludedDisabledCases?: string[];
	protectedCorpus?: Array<{ path: string; sha256: string }>;
};
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
function validatePinnedManifest(manifest: Manifest): void {
	const expected = buildExecutionManifest(process.cwd());
	const equalStrings = (actual: unknown, expectedValues: string[]): boolean =>
		Array.isArray(actual) &&
		actual.length === expectedValues.length &&
		actual.every((value, index) => value === expectedValues[index]);
	const actualCorpus = manifest.protectedCorpus;
	const corpusMatches =
		Array.isArray(actualCorpus) &&
		actualCorpus.length === expected.protectedCorpus.length &&
		actualCorpus.every(
			(entry, index) =>
				entry?.path === expected.protectedCorpus[index]?.path &&
				entry?.sha256 === expected.protectedCorpus[index]?.sha256,
		);
	const current = currentManifest(process.cwd(), expected.protectedCorpus);
	const currentMatches = expected.protectedCorpus.every((entry) => current.get(entry.path) === entry.sha256);
	if (
		manifest.baselineSha !== expected.baselineSha ||
		manifest.packageJsonSha256 !== expected.packageJsonSha256 ||
		!equalStrings(manifest.roots, expected.roots) ||
		!equalStrings(manifest.filters, expected.filters) ||
		!equalStrings(manifest.excludedDisabledCases, expected.excludedDisabledCases) ||
		!corpusMatches
	)
		fail("manifest does not match the pinned baseline manifest");
	if (!currentMatches) fail("current worktree does not match the pinned baseline corpus");
}
const manifestValue = required("--manifest");
const pathsValue = required("--paths");
const report = resolve(required("--report"));
const manifest = readManifest(manifestValue);
validatePinnedManifest(manifest);
const artifact = resolve(required("--artifact"));
const coreDriver = resolve(required("--core-driver"));
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
if (!isFreshTargetArtifact(coreDriver, "rust-core"))
	fail("core driver artifact is stale or outside the fresh Rust core target");
try {
	validateRustDaemonArtifact({
		artifact,
		checkout: process.cwd(),
		provenance: arg("--provenance"),
	});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
if (isForbiddenPath(coreDriver) || isForbiddenPath(artifact))
	fail("forbidden archived daemon/source path in execution boundary");
/* Keep the daemon checks explicit and unchanged in meaning. */
if (!existsSync(artifact) || !statSync(artifact).isFile() || (statSync(artifact).mode & 0o111) === 0)
	fail("artifact must be an executable file");
if (isForbiddenPath(artifact) || isForbiddenPath(process.cwd()))
	fail("forbidden daemon/source path in execution boundary");
const entries = new Map(manifest.protectedCorpus?.map((entry) => [entry.path, entry.sha256]) ?? []);
let paths: unknown;
try {
	paths = JSON.parse(pathsValue);
} catch {
	fail("--paths must be valid JSON");
}
if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string"))
	fail("--paths must be a non-empty JSON string array");
const rawPaths = paths as string[];
if (new Set(rawPaths).size !== rawPaths.length) fail("--paths contains duplicate selected paths");
const selected = [...rawPaths].sort();
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
if (!existsSync(junitPath)) {
	// Preserve an auditable, fail-closed report when the unchanged child cannot
	// produce JUnit (for example, a spawn failure or infrastructure signal).
	// Do not synthesize testcase identities: zero cases remains incomplete.
	writeFileSync(
		report,
		`<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" nativeEvidence="${nativeEvidence}" tests="0" failures="0" errors="1" skipped="0"/>`,
	);
	if (existsSync(evidenceFile)) unlinkSync(evidenceFile);
	if (existsSync(daemonEvidenceFile)) unlinkSync(daemonEvidenceFile);
	console.error(
		JSON.stringify({
			backend: "fresh-rust",
			artifact,
			selected,
			executed: [],
			nativeEvidence,
			childStatus: child.status,
			childSignal: child.signal,
			infrastructureFailure: true,
			missingSelected: selected,
			unexpectedFiles: [],
			reason: evidence.slice(-8192),
		}),
	);
	process.exit(2);
}
const reportXml = readFileSync(junitPath, "utf8");
const cases = reportXml.match(/<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
if (!cases.length) fail(`Rust child produced no real testcase identities: ${evidence}`);
const attribute = (source: string, name: string): string => {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? "";
};
const observedFiles = new Set(cases.map((testcase) => attribute(testcase, "file")).filter(Boolean));
const missingIdentity = cases.some((testcase) => !attribute(testcase, "file"));
const missingSelected = selected.filter((path) => !observedFiles.has(path));
const unexpectedFiles = [...observedFiles].filter((path) => !selected.includes(path));
const infrastructureFailure =
	child.signal !== null ||
	child.error !== undefined ||
	!cases.length ||
	missingIdentity ||
	missingSelected.length > 0 ||
	unexpectedFiles.length > 0;
const wrappedReport = wrapRustJUnitReport(reportXml, nativeEvidence);
writeFileSync(report, wrappedReport.xml);
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
