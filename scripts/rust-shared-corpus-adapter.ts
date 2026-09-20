#!/usr/bin/env bun
/** Execute unchanged pinned baseline tests against the fresh Rust daemon only. */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const BASELINE = "11e4720c07107caf7fdd57a685eca24e8a82e654";
const ADAPTED = new Set(["platform/daemon/src/workspace-startup.test.ts"]);
const FORBIDDEN =
	/(?:^|\/)(?:platform\/daemon-rs|platform\/rust-daemon-rs|platform\/daemon-rs|platform\/daemon\/src\/daemon\.ts)(?:\/|$)/;

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

const artifact = resolve(required("--artifact"));
const manifestPath = resolve(required("--manifest"));
const pathsPath = required("--paths");
const report = resolve(required("--report"));
if (!existsSync(artifact) || !statSync(artifact).isFile() || (statSync(artifact).mode & 0o111) === 0)
	fail("artifact must be an executable file");
if (basename(artifact) !== "signet-daemon") fail("artifact identity is not the fresh Rust daemon");
if (FORBIDDEN.test(artifact) || FORBIDDEN.test(process.cwd()))
	fail("forbidden daemon/source path in execution boundary");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
if (manifest.baselineSha !== BASELINE) fail(`manifest baseline must be ${BASELINE}`);
if (!manifest.protectedCorpus || manifest.protectedCorpus.length !== 497)
	fail("manifest must contain the pinned 497-path corpus");
const entries = new Map(manifest.protectedCorpus.map((e) => [e.path, e.sha256]));
const paths = JSON.parse(pathsPath) as unknown;
if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string"))
	fail("--paths must be a non-empty JSON string array");
const selected = [...new Set(paths as string[])].sort();
for (const path of selected) if (!entries.has(path)) fail(`requested path is outside the pinned corpus: ${path}`);
const adapted = selected.filter((path) => ADAPTED.has(path));
const unsupported = selected.filter((path) => !ADAPTED.has(path));

mkdirSync(dirname(report), { recursive: true });
const junitPath = `${report}.bun.xml`;
const cases: string[] = [];
let exitCode = 0;
if (adapted.length) {
	const child = spawnSync(
		"bun",
		[
			"test",
			"--preload",
			resolve(import.meta.dir, "rust-baseline-proof-daemon.preload.ts"),
			"--reporter=junit",
			`--reporter-outfile=${junitPath}`,
			...adapted,
		],
		{
			cwd: process.cwd(),
			env: { ...process.env, SIGNET_RUST_DAEMON_BIN: artifact },
			encoding: "utf8",
		},
	);
	exitCode = child.status ?? 1;
	if (existsSync(junitPath)) {
		const xml = readFileSync(junitPath, "utf8");
		const matches = xml.match(/<testcase\b[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g);
		if (matches) cases.push(...matches);
	}
	if (!cases.length)
		cases.push(
			`<testcase classname="${adapted.join(",")}" name="rust-adapter-execution"><error message="Rust test process produced no JUnit testcase"/></testcase>`,
		);
}
for (const path of unsupported)
	cases.push(
		`<testcase classname="rust-shared-corpus-adapter" name="${path.replaceAll("&", "&amp;")}"><failure message="unadapted Rust responsibility"/></testcase>`,
	);
const failures = cases.filter((c) => /<(?:failure|error)\b/.test(c)).length;
const xml = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="rust-shared-corpus" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">${cases.join("")}</testsuite>`;
writeFileSync(report, xml);
console.error(
	JSON.stringify({ backend: "fresh-rust", artifact, selected, executed: adapted, unadapted: unsupported, exitCode }),
);
process.exit(failures || exitCode !== 0 ? 1 : 0);
