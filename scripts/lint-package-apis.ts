#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

import { listPublishableManifestTargets } from "./check-publish-manifests";

let failed = false;

for (const manifest of listPublishableManifestTargets()) {
	const directory = dirname(manifest);
	console.log(`\n==> ${directory}`);

	for (const args of [
		["publint", "run", "--strict", directory],
		["attw", "--pack", directory, "--format", "table"],
	]) {
		try {
			execFileSync("bunx", args, { stdio: "inherit" });
		} catch {
			failed = true;
		}
	}
}

if (failed) process.exit(1);
