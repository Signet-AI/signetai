#!/usr/bin/env bun
/** External reporting launcher; protected baseline tests remain unchanged. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildHermeticEnvironment } from "./run-hermetic-tests";

const args = Bun.argv.slice(2);
const reportFlag = args.indexOf("--report");
if (reportFlag < 0 || !args[reportFlag + 1]) throw new Error("typescript launcher requires --report");
const report = resolve(args[reportFlag + 1] as string);
const selected = args.filter((_, index) => index !== reportFlag && index !== reportFlag + 1);
if (selected.length === 0 || new Set(selected).size !== selected.length)
	throw new Error("typescript launcher requires unique selected entrypoints");
mkdirSync(dirname(report), { recursive: true });
if (existsSync(report)) unlinkSync(report);
const root = mkdtempSync(join(tmpdir(), "signet-ts-corpus-"));
const cases: string[] = [];
let failed = false;
const maxBatchSize = 16;
const processExitPattern = /\b(?:process\.exit|Bun\.exit|Deno\.exit|process\.kill|SIGTERM)\b/;
const processExitSensitive = (entry: string): boolean => {
	try {
		return processExitPattern.test(readFileSync(resolve(entry), "utf8"));
	} catch {
		return true;
	}
};
const batches: string[][] = [];
let batch: string[] = [];
const flush = () => {
	if (batch.length > 0) batches.push(batch);
	batch = [];
};
for (const entry of selected) {
	if (processExitSensitive(entry)) {
		flush();
		batches.push([entry]);
	} else {
		batch.push(entry);
		if (batch.length >= maxBatchSize) flush();
	}
}
flush();
try {
	const runEntries = (entries: string[], label: string) => {
		const dir = join(root, `${label}-${randomUUID()}`);
		mkdirSync(dir);
		const junit = join(dir, "report.xml");
		const env = buildHermeticEnvironment(process.env, join(dir, "hermetic"));
		let child: ReturnType<typeof spawnSync> | undefined;
		try {
			child = spawnSync(
				"bun",
				["run", "test:hermetic", "--", ...entries, "--reporter=junit", `--reporter-outfile=${junit}`],
				{
					cwd: process.cwd(),
					env,
					encoding: "utf8",
					maxBuffer: 128 * 1024 * 1024,
					timeout: 120_000,
				},
			);
		} catch {
			/* reported below as incomplete */
		}
		if (child?.stdout) process.stdout.write(child.stdout);
		if (child?.stderr) process.stderr.write(child.stderr);
		const hasReport = existsSync(junit);
		const xml = hasReport ? readFileSync(junit, "utf8") : "";
		const found = xml.match(/<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
		cases.push(...found);
		const observed = new Set([...xml.matchAll(/\bfile="([^"]+)"/g)].map((match) => match[1]));
		if (child?.status !== 0 || child.signal || child.error || !hasReport) failed = true;
		return { observed, hasReport };
	};

	for (let i = 0; i < batches.length; i++) {
		const entries = batches[i];
		if (!entries) continue;
		const result = runEntries(entries, `${String(i).padStart(4, "0")}`);
		const missing = entries.filter((entry) => !result.observed.has(entry));
		if (missing.length > 0 && entries.length > 1) {
			for (const [retryIndex, entry] of missing.entries()) {
				runEntries([entry], `${String(i).padStart(4, "0")}-retry-${retryIndex}`);
			}
		}
	}
	const failures = cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length;
	const skipped = cases.filter((testcase) => /<skipped\b/.test(testcase)).length;
	failed ||= cases.length === 0 || failures > 0;
	writeFileSync(
		report,
		`<?xml version="1.0" encoding="UTF-8"?><testsuite name="typescript-shared-corpus" tests="${cases.length}" failures="${failures}" errors="${failed && cases.length === 0 ? 1 : 0}" skipped="${skipped}">${cases.join("")}</testsuite>`,
	);
	if (failed) process.exitCode = 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}
