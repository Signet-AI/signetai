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
if (existsSync(evidenceFile)) unlinkSync(evidenceFile);
const stdoutPath = `${report}.stdout`;
const stderrPath = `${report}.stderr`;
for (const path of [stdoutPath, stderrPath]) if (existsSync(path)) unlinkSync(path);
const escapeXml = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");
function parseConsoleCases(output: string, batchIndex: number): { cases: string[]; observed: Set<string> } {
	const cases: string[] = [];
	const observed = new Set<string>();
	let currentFile = `bun-output-batch-${batchIndex}`;
	for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = selected.find((path) => line.endsWith(`${path}:`));
		if (heading) {
			currentFile = heading;
			continue;
		}
		const match = line.match(/^\((pass|fail|skip|todo)\)\s+(.+?)(?:\s+\[[^\]]+\])?$/);
		if (!match) continue;
		const status = match[1] ?? "";
		const name = match[2] ?? "";
		if (selected.includes(currentFile)) observed.add(currentFile);
		const body =
			status === "fail"
				? `<failure message="${escapeXml(name)}">${escapeXml(line)}</failure>`
				: status === "skip" || status === "todo"
					? "<skipped/>"
					: "";
		cases.push(`<testcase classname="${escapeXml(currentFile)}" name="${escapeXml(name)}">${body}</testcase>`);
	}
	return { cases, observed };
}
const chunkSize = 64;
const chunks: string[][] = [];
for (let offset = 0; offset < selected.length; offset += chunkSize)
	chunks.push(selected.slice(offset, offset + chunkSize));
const cases: string[] = [];
const observedFiles = new Set<string>();
let combinedStdout = "";
let combinedStderr = "";
let nativeEvidence = false;
let infrastructureFailure = false;
const childStatuses: Array<number | null> = [];
for (const [batchIndex, batch] of chunks.entries()) {
	const junitPath = `${report}.batch-${batchIndex}.bun.xml`;
	const batchStdoutPath = `${report}.batch-${batchIndex}.stdout`;
	const batchStderrPath = `${report}.batch-${batchIndex}.stderr`;
	for (const path of [junitPath, batchStdoutPath, batchStderrPath]) if (existsSync(path)) unlinkSync(path);
	const stdoutFd = openSync(batchStdoutPath, "w");
	const stderrFd = openSync(batchStderrPath, "w");
	let child: ReturnType<typeof spawnSync> | null = null;
	try {
		child = spawnSync(
			"bun",
			[
				"test",
				"--preload",
				resolve(import.meta.dir, "rust-shared-corpus-combined.preload.ts"),
				"--reporter=junit",
				`--reporter-outfile=${junitPath}`,
				...batch,
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					SIGNET_RUST_DAEMON_BIN: artifact,
					SIGNET_RUST_CORE_DRIVER_BIN: coreDriver,
					SIGNET_RUST_CORE_EVIDENCE_FILE: evidenceFile,
				},
				stdio: ["ignore", stdoutFd, stderrFd],
			},
		);
	} catch (error) {
		infrastructureFailure = true;
		combinedStderr += `adapter spawn failure: ${error instanceof Error ? error.message : String(error)}\n`;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
	const batchStderr = existsSync(batchStderrPath) ? readFileSync(batchStderrPath, "utf8") : "";
	const batchStdout = existsSync(batchStdoutPath) ? readFileSync(batchStdoutPath, "utf8") : "";
	combinedStdout += batchStdout;
	combinedStderr += batchStderr;
	if (child === null) {
		infrastructureFailure = true;
		continue;
	}
	childStatuses.push(child.status);
	if (child.signal || child.error) infrastructureFailure = true;
	let batchCases: string[] = [];
	if (existsSync(junitPath)) {
		const reportXml = readFileSync(junitPath, "utf8");
		batchCases = reportXml.match(/<testcase\b[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g) ?? [];
		for (const testcase of batchCases) {
			for (const path of batch) if (testcase.includes(path)) observedFiles.add(path);
		}
	} else {
		infrastructureFailure = true;
		const recovered = parseConsoleCases(batchStderr || batchStdout, batchIndex);
		batchCases = recovered.cases;
		for (const path of recovered.observed) observedFiles.add(path);
	}
	cases.push(...batchCases);
	if (existsSync(evidenceFile)) {
		const evidence = readFileSync(evidenceFile, "utf8");
		if (/backend=fresh-rust artifact=signet-core-test-driver process=transport/.test(evidence)) nativeEvidence = true;
		if (/"backend"\s*:\s*"rust-daemon"/.test(evidence)) nativeEvidence = true;
	}
	for (const path of [junitPath, batchStdoutPath, batchStderrPath]) if (existsSync(path)) unlinkSync(path);
}
writeFileSync(stdoutPath, combinedStdout);
writeFileSync(stderrPath, combinedStderr);
if (!cases.length) fail(`Rust child produced no real testcase identities: ${combinedStderr || combinedStdout}`);
if (!nativeEvidence) fail(`Rust child produced no native boundary evidence: ${combinedStderr || combinedStdout}`);
const failures = cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length;
writeFileSync(
	report,
	`<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">${cases.join("")}</testsuite>`,
);
if (existsSync(evidenceFile)) unlinkSync(evidenceFile);
console.error(
	JSON.stringify({
		backend: "fresh-rust",
		artifact,
		selected: selected.length,
		executed: selected,
		observedFiles: observedFiles.size,
		nativeEvidence,
		childStatuses,
		infrastructureFailure,
		stderrBytes: Buffer.byteLength(combinedStderr),
		stdoutBytes: Buffer.byteLength(combinedStdout),
	}),
);
process.exit(infrastructureFailure ? 2 : 0);
