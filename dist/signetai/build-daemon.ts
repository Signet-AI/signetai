/**
 * Daemon build for the signetai meta-package — mirrors
 * platform/daemon/build.ts with the same externals and aliases.
 */

import { build } from "esbuild";

const EXTERNAL = ["better-sqlite3", "bun:sqlite", "@1password/sdk", "onnxruntime-node", "@huggingface/transformers"];

const ALIAS: Record<string, string> = {
	sharp: "../../platform/daemon/src/shims/sharp.ts",
};

const targets: Array<{
	entrypoint: string;
	outfile: string;
}> = [
	{ entrypoint: "../../platform/daemon/src/daemon.ts", outfile: "./dist/daemon.js" },
	{ entrypoint: "../../platform/daemon/src/mcp-stdio.ts", outfile: "./dist/mcp-stdio.js" },
	{ entrypoint: "../../platform/daemon/src/synthesis-render-worker.ts", outfile: "./dist/synthesis-render-worker.js" },
	{ entrypoint: "../../platform/daemon/src/pipeline/extraction-thread.ts", outfile: "./dist/extraction-thread.js" },
];

let ok = true;

for (const { entrypoint, outfile } of targets) {
	try {
		const result = await build({
			entryPoints: [entrypoint],
			bundle: true,
			outfile,
			platform: "node",
			target: "node20",
			external: EXTERNAL,
			alias: ALIAS,
			format: "esm",
			banner: {
				js: 'import { createRequire as __createRequire } from "module"; const __require = __createRequire(import.meta.url);',
			},
			logLevel: "warning",
		});

		const { statSync } = await import("node:fs");
		const size = statSync(outfile).size;
		const mb = (size / 1024 / 1024).toFixed(1);
		console.log(`  ${outfile}  ${mb} MB`);
	} catch (err) {
		console.error(`Build failed: ${entrypoint}`);
		console.error(err);
		ok = false;
	}
}

if (!ok) process.exit(1);
