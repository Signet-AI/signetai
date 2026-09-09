#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const daemonRoot = join(root, "platform", "daemon");
const daemonDist = join(daemonRoot, "dist");
const dashboard = join(daemonRoot, "dashboard");
const skills = join(daemonRoot, "skills");
const tiktokenWasm = join(daemonRoot, "node_modules", "tiktoken", "tiktoken_bg.wasm");
const daemonPackage = JSON.parse(readFileSync(join(daemonRoot, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
};
const firecrawlVersion = daemonPackage.dependencies?.["@firecrawl/anydoc"];
const output = join(root, "dist", "signetai", "runtime", "daemon-js");

function copyDirectory(source: string, target: string): void {
	if (!existsSync(source) || !statSync(source).isDirectory()) {
		throw new Error(`Required daemon runtime directory is missing: ${source}`);
	}
	cpSync(source, target, { recursive: true, dereference: true });
}

function stageFirecrawlDependencies(target: string): void {
	if (!firecrawlVersion) throw new Error("@firecrawl/anydoc is missing from the daemon dependencies");
	const temporary = mkdtempSync(join(root, "dist", ".daemon-js-firecrawl-"));
	try {
		writeFileSync(
			join(temporary, "package.json"),
			`${JSON.stringify({ name: "signet-daemon-js-dependencies", private: true, dependencies: { "@firecrawl/anydoc": firecrawlVersion } })}\n`,
		);
		const result = spawnSync(process.execPath, ["install", "--production", "--ignore-scripts", "--os=*", "--cpu=*"], {
			cwd: temporary,
			stdio: "inherit",
		});
		if (result.status !== 0)
			throw new Error(`Firecrawl dependency staging exited with status ${result.status ?? "unknown"}`);
		copyDirectory(join(temporary, "node_modules", "@firecrawl"), join(target, "vendor", "node_modules", "@firecrawl"));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (!existsSync(join(daemonDist, "daemon.js"))) {
	throw new Error(`Built daemon bundle is missing: ${join(daemonDist, "daemon.js")}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const entry of readdirSync(daemonDist)) {
	if (!entry.endsWith(".js") && !entry.endsWith(".map") && !entry.endsWith(".node")) continue;
	const source = join(daemonDist, entry);
	if (entry.endsWith(".node")) {
		cpSync(source, join(output, entry));
		continue;
	}
	cpSync(source, join(output, entry));
}
copyDirectory(dashboard, join(output, "dashboard"));
copyDirectory(skills, join(output, "skills"));
if (!existsSync(tiktokenWasm) || !statSync(tiktokenWasm).isFile()) {
	throw new Error(`Required tokenizer WASM asset is missing: ${tiktokenWasm}`);
}
mkdirSync(join(output, "vendor"), { recursive: true });
cpSync(tiktokenWasm, join(output, "vendor", "tiktoken_bg.wasm"));
stageFirecrawlDependencies(output);

writeFileSync(
	join(output, "runtime-manifest.json"),
	`${JSON.stringify(
		{
			format: "signet-daemon-js",
			workers: readdirSync(daemonDist)
				.filter(
					(entry) =>
						entry.endsWith("-worker.js") ||
						entry === "transcript-recovery-child.js" ||
						entry === "transcript-recovery-supervisor.js",
				)
				.sort(),
			profile: readdirSync(daemonDist).some((entry) => entry.endsWith(".map")),
		},
		null,
		2,
	)}\n`,
);

console.log(`Staged Bun JavaScript daemon runtime in ${output}`);
