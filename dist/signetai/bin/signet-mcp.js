#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = process.platform === "win32" ? "signet-mcp.exe" : "signet-mcp";
const override = process.env.SIGNET_RUST_MCP_BIN?.trim();
const target = override || join(packageDir, "runtime", "rust-daemon", `${process.platform}-${process.arch}`, binary);
if (!existsSync(target)) {
	console.error(`Signet native MCP binary is missing: ${target}`);
	process.exit(1);
}
const child = spawn(target, process.argv.slice(2), { stdio: "inherit", windowsHide: true, env: process.env });
child.on("error", (error) => {
	console.error(`Failed to start signet-mcp: ${error.message}`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
