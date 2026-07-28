/**
 * Build script for Signet browser extension
 * Outputs to dist/chrome/ and dist/firefox/
 */

import { cpSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

type Target = "chrome" | "firefox";

const ENTRY_POINTS = {
	"popup/popup": join(SRC, "popup/popup.ts"),
	"background/service-worker": join(SRC, "background/service-worker.ts"),
	"content/content": join(SRC, "content/content.ts"),
	"options/options": join(SRC, "options/options.ts"),
} as const;

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");
const targetArg = args.find((a) => a.startsWith("--target"))?.split("=")[1] ?? args[args.indexOf("--target") + 1];
const targets: readonly Target[] =
	targetArg === "chrome" ? ["chrome"] : targetArg === "firefox" ? ["firefox"] : ["chrome", "firefox"];

function loadManifest(): Record<string, unknown> {
	const raw = readFileSync(join(ROOT, "manifest.json"), "utf-8");
	return JSON.parse(raw) as Record<string, unknown>;
}

function buildManifest(target: Target): Record<string, unknown> {
	const base = loadManifest();

	if (target === "firefox") {
		// Firefox uses background.scripts instead of service_worker
		const bg = base.background as Record<string, unknown> | undefined;
		if (bg?.service_worker) {
			bg.scripts = [bg.service_worker];
			delete bg.service_worker;
		}
		// Add Firefox-specific settings
		base.browser_specific_settings = {
			gecko: {
				id: "signet@signet.ai",
				strict_min_version: "128.0",
			},
		};
	}

	return base;
}

function copyStaticFiles(outDir: string): void {
	// Copy HTML files
	for (const dir of ["popup", "options"]) {
		const htmlSrc = join(SRC, dir, "index.html");
		if (existsSync(htmlSrc)) {
			cpSync(htmlSrc, join(outDir, dir, "index.html"));
		}
	}

	// Copy icons
	const iconsDir = join(SRC, "icons");
	if (existsSync(iconsDir)) {
		cpSync(iconsDir, join(outDir, "icons"), { recursive: true });
	}

	// Copy CSS files
	for (const cssPath of ["content/content.css", "popup/popup.css"]) {
		const src = join(SRC, cssPath);
		if (existsSync(src)) {
			cpSync(src, join(outDir, cssPath));
		}
	}
}

async function buildTarget(target: Target): Promise<void> {
	const outDir = join(DIST, target);
	mkdirSync(outDir, { recursive: true });

	// Build TypeScript entry points
	const entrypoints = Object.values(ENTRY_POINTS);
	const result = await Bun.build({
		entrypoints,
		outdir: outDir,
		target: "browser",
		format: "esm",
		splitting: false,
		sourcemap: "external",
		minify: !isWatch,
		naming: "[dir]/[name].[ext]",
		root: SRC,
	});

	if (!result.success) {
		console.error(`Build failed for ${target}:`);
		for (const log of result.logs) {
			console.error(log);
		}
		process.exit(1);
	}

	// Write manifest
	const manifest = buildManifest(target);
	writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

	// Copy static files
	copyStaticFiles(outDir);

	console.log(`Built ${target} → ${outDir}`);
}

async function build(): Promise<void> {
	for (const target of targets) {
		await buildTarget(target);
	}
}

await build();

if (isWatch) {
	console.log("Watching for changes...");
	const watcher = watch(SRC, { recursive: true }, async (_event, _filename) => {
		console.log("Rebuilding...");
		await build().catch(console.error);
	});
	process.on("SIGINT", () => {
		watcher.close();
		process.exit(0);
	});
}
