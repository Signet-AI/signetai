#!/usr/bin/env bun
/** External reporting launcher; protected baseline tests remain unchanged. */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = Bun.argv.slice(2);
const reportFlag = args.indexOf("--report");
if (reportFlag < 0 || !args[reportFlag + 1]) throw new Error("typescript launcher requires --report");
const reportValue = args[reportFlag + 1] as string;
const report = resolve(reportValue);
const selected = args.filter((value, index) => value !== "--report" && index !== reportFlag + 1);
if (existsSync(report)) unlinkSync(report);
const child = spawnSync(
	"bun",
	["run", "test:hermetic", "--", ...selected, "--reporter=junit", `--reporter-outfile=${report}`],
	{
		cwd: process.cwd(),
		env: { ...process.env },
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	},
);
const decodeOutput = (output: string | Uint8Array | null): string =>
	typeof output === "string" ? output : output ? new TextDecoder().decode(output) : "";
const stdout = decodeOutput(child.stdout);
const stderr = decodeOutput(child.stderr);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (!existsSync(report)) {
	const escapeXml = (value: string): string =>
		value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
	const selectedPaths = selected.filter((value) => !value.startsWith("--"));
	let currentFile = "bun-output";
	const cases: string[] = [];
	for (const rawLine of `${stdout}\n${stderr}`
		.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
		.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = selectedPaths.find((path) => line.endsWith(`${path}:`));
		if (heading) {
			currentFile = heading;
			continue;
		}
		const match = line.match(/^\((pass|fail|skip|todo)\)\s+(.+?)(?:\s+\[[^\]]+\])?$/);
		if (!match) continue;
		const status = match[1] ?? "";
		const name = match[2] ?? "";
		const body =
			status === "fail"
				? `<failure message="${escapeXml(name)}">${escapeXml(line)}</failure>`
				: status === "skip" || status === "todo"
					? "<skipped/>"
					: "";
		cases.push(
			`<testcase classname="${escapeXml(currentFile)}" name="${escapeXml(name)}" file="${escapeXml(currentFile)}">${body}</testcase>`,
		);
	}
	if (cases.length) {
		const failures = cases.filter((testcase) => /<failure\b/.test(testcase)).length;
		const skipped = cases.filter((testcase) => /<skipped\b/.test(testcase)).length;
		writeFileSync(
			report,
			`<?xml version="1.0" encoding="UTF-8"?><testsuite name="typescript-shared-corpus" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}">${cases.join("")}</testsuite>`,
		);
	}
}
process.exit(child.status ?? 1);
