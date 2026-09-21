#!/usr/bin/env bun
/** External reporting launcher; protected baseline tests remain unchanged. */
import { existsSync, unlinkSync } from "node:fs";
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
		stdio: "inherit",
	},
);
process.exit(child.status ?? 1);
