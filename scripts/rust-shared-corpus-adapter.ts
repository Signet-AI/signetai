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
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename, dirname, isAbsolute, relative, sep, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	BASELINE_FILTERS,
	BASELINE_ROOTS,
	BASELINE_SHA,
	CORPUS_SIZE,
	PREEXISTING_DISABLED_CASES,
	buildExecutionManifest,
	currentManifest,
	discoverBaselinePaths,
} from "./shared-corpus-runner";
import { buildHermeticEnvironment } from "./run-hermetic-tests";
import { validateRustDaemonArtifact } from "./rust-shared-corpus-artifact";
import {
	extractTestsuiteFragment,
	normalizeObservedJUnitCounters,
	wrapRustJUnitReport,
} from "./rust-shared-corpus-report";
import { isFreshRustCoreEvidenceLine } from "./rust-baseline-proof-evidence";

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
	// Reject obviously forged manifests before hashing all 497 baseline files.
	const equalStrings = (actual: unknown, expectedValues: string[]): boolean =>
		Array.isArray(actual) &&
		actual.length === expectedValues.length &&
		actual.every((value, index) => value === expectedValues[index]);
	if (
		manifest.baselineSha !== BASELINE_SHA ||
		!equalStrings(manifest.roots, BASELINE_ROOTS) ||
		!equalStrings(manifest.filters, BASELINE_FILTERS) ||
		!equalStrings(manifest.excludedDisabledCases, PREEXISTING_DISABLED_CASES) ||
		!Array.isArray(manifest.protectedCorpus) ||
		manifest.protectedCorpus.length !== CORPUS_SIZE
	)
		fail("manifest does not match the pinned baseline manifest");
	const baselinePaths = discoverBaselinePaths(process.cwd());
	if (
		manifest.protectedCorpus.some(
			(entry, index) =>
				!entry ||
				typeof entry.path !== "string" ||
				typeof entry.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(entry.sha256) ||
				entry.path !== baselinePaths[index],
		)
	)
		fail("manifest does not match the pinned baseline manifest");
	const expected = buildExecutionManifest(process.cwd());
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
const scope = arg("--scope") ?? "combined";
if (scope !== "combined" && scope !== "core" && scope !== "daemon") fail("--scope must be combined, core, or daemon");
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
const hermeticRoot = mkdtempSync(join(tmpdir(), "signet-rust-test-run-"));
const hermeticEnv = buildHermeticEnvironment(process.env, hermeticRoot);
const processExitPattern = /\b(?:process\.exit|Bun\.exit|Deno\.exit|process\.kill|SIGTERM)\b/;
const processExitSensitive = (entry: string): boolean => {
	try {
		return processExitPattern.test(readFileSync(resolve(entry), "utf8"));
	} catch {
		return true;
	}
};
const batches: string[][] = [];
const maxBatchSize = 1;
let currentBatch: string[] = [];
const flushBatch = () => {
	if (currentBatch.length > 0) batches.push(currentBatch);
	currentBatch = [];
};
for (const entry of selected) {
	if (processExitSensitive(entry)) {
		flushBatch();
		batches.push([entry]);
	} else {
		currentBatch.push(entry);
		if (currentBatch.length >= maxBatchSize) flushBatch();
	}
}
flushBatch();
let child: ReturnType<typeof spawnSync> | undefined;
let spawnError: unknown;
const junitReports: string[] = [];
const batchRecords: Array<{ selected: string[]; status: number | null; signal: string | null; error?: string }> = [];
let anyBatchFailed = false;
for (let index = 0; index < batches.length; index++) {
	const entriesForBatch = batches[index];
	if (!entriesForBatch) continue;
	const batchRoot = mkdtempSync(join(tmpdir(), "signet-rust-test-batch-"));
	const batchJUnit = join(batchRoot, "report.xml");
	const batchEvidence = join(batchRoot, "core-evidence");
	const batchDaemonEvidence = join(batchRoot, "daemon-evidence");
	const batchEnv = buildHermeticEnvironment(hermeticEnv, join(batchRoot, "hermetic"));
	const outFd = openSync(stdoutPath, "a");
	const errFd = openSync(stderrPath, "a");
	let result: ReturnType<typeof spawnSync> | undefined;
	let error: unknown;
	try {
		result = spawnSync(
			"bun",
			[
				"test",
				"--preload",
				resolve(import.meta.dir, "rust-shared-corpus-combined.preload.ts"),
				"--reporter=junit",
				`--reporter-outfile=${batchJUnit}`,
				...entriesForBatch,
			],
			{
				cwd: process.cwd(),
				env: {
					...batchEnv,
					SIGNET_RUST_DAEMON_BIN: artifact,
					SIGNET_RUST_DAEMON_EVIDENCE_FILE: batchDaemonEvidence,
					SIGNET_RUST_EVIDENCE_NONCE: evidenceNonce,
					SIGNET_RUST_CORE_DRIVER_BIN: coreDriver,
					SIGNET_RUST_CORE_EVIDENCE_FILE: batchEvidence,
				},
				stdio: ["ignore", outFd, errFd],
				timeout: 120_000,
			},
		);
	} catch (caught) {
		error = caught;
		spawnError ??= caught;
	} finally {
		closeSync(outFd);
		closeSync(errFd);
	}
	child = result ?? child;
	batchRecords.push({
		selected: entriesForBatch,
		status: result?.status ?? null,
		signal: result?.signal ?? null,
		...(error ? { error: String(error) } : {}),
	});
	if (result?.status !== 0 || result.signal || error) anyBatchFailed = true;
	if (existsSync(batchJUnit)) {
		const xml = readFileSync(batchJUnit, "utf8");
		const fragment = extractTestsuiteFragment(xml);
		if (fragment) junitReports.push(fragment);
	}
	for (const [source, target] of [
		[batchEvidence, evidenceFile],
		[batchDaemonEvidence, daemonEvidenceFile],
	] as const) {
		if (existsSync(source))
			writeFileSync(target, `${existsSync(target) ? readFileSync(target, "utf8") : ""}${readFileSync(source, "utf8")}`);
	}
	rmSync(batchRoot, { recursive: true, force: true });
}
rmSync(hermeticRoot, { recursive: true, force: true });
const aggregate = normalizeObservedJUnitCounters(
	`<?xml version="1.0" encoding="UTF-8"?><testsuites>${junitReports.join("")}</testsuites>`,
);
if (junitReports.length) writeFileSync(junitPath, aggregate);
if (!child) {
	const message = spawnError instanceof Error ? spawnError.message : String(spawnError ?? "unknown spawn error");
	fail(`Rust child could not start: ${message}`);
}
const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
const daemonEvidenceLines = existsSync(daemonEvidenceFile)
	? readFileSync(daemonEvidenceFile, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
	: [];
const daemonEvidenceRecords = daemonEvidenceLines.map((line) => {
	try {
		return JSON.parse(line) as {
			backend?: string;
			binary?: string;
			nonce?: string;
			transport?: string;
			pid?: unknown;
			exitCode?: unknown;
			success?: unknown;
			status?: string;
		};
	} catch {
		return null;
	}
});
const daemonEvidence =
	daemonEvidenceLines.length > 0 &&
	daemonEvidenceRecords.every(
		(value) =>
			value !== null &&
			value.backend === "rust-daemon" &&
			value.binary === artifact &&
			value.nonce === evidenceNonce &&
			typeof value.pid === "number" &&
			value.pid > 0 &&
			((value.transport === "spawn" && value.status === "native-created" && value.success === null) ||
				(value.transport === "spawnSync" &&
					value.status === "native-completed" &&
					typeof value.exitCode === "number" &&
					typeof value.success === "boolean")),
	);
const coreEvidenceLines = existsSync(evidenceFile)
	? readFileSync(evidenceFile, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
	: [];
const coreEvidence =
	coreEvidenceLines.length > 0 && coreEvidenceLines.every((line) => isFreshRustCoreEvidenceLine(line, coreDriver));
// The complete corpus is authoritative only when both unchanged execution
// boundaries were exercised. Supplementary proof runs are intentionally
// narrower: direct-core paths prove the core transport, daemon paths prove
// the native daemon replacement, and mixed/full runs still require both.
const nativeEvidence =
	scope === "core" ? coreEvidence : scope === "daemon" ? daemonEvidence : daemonEvidence && coreEvidence;
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
	console.error(
		JSON.stringify({
			backend: "fresh-rust",
			artifact,
			scope,
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
	anyBatchFailed ||
	!nativeEvidence ||
	child.signal !== null ||
	child.error !== undefined ||
	!cases.length ||
	missingIdentity ||
	missingSelected.length > 0 ||
	unexpectedFiles.length > 0;
const wrappedReport = wrapRustJUnitReport(reportXml, nativeEvidence);
writeFileSync(report, wrappedReport.xml);
console.error(
	JSON.stringify({
		backend: "fresh-rust",
		artifact,
		scope,
		selected,
		executed: [...observedFiles].sort(),
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
