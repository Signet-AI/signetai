#!/usr/bin/env node
/**
 * Cross-platform build script for tray TypeScript assets.
 * Replaces Unix-only rm -rf / cp -r in package.json scripts.
 */
import { rmSync, cpSync, copyFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Clean dist
rmSync("dist", { recursive: true, force: true });

// Bundle TypeScript
execSync("bun build src-ts/index.ts --outfile dist/tray.js --target browser --minify", { stdio: "inherit" });

// Build dashboard
execSync("bun run build:dashboard", { stdio: "inherit" });

// Copy dashboard build contents into dist (not the directory itself)
const src = "../cli/dashboard/build";
for (const entry of readdirSync(src)) {
	cpSync(join(src, entry), join("dist", entry), { recursive: true });
}

// Copy HTML files
for (const file of ["tray.html", "capture.html", "search.html"]) {
	copyFileSync(file, `dist/${file}`);
}
