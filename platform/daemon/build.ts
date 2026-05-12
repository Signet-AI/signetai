/**
 * Daemon build script — uses esbuild to alias native packages
 * that break when bundled (baked paths to .node/.wasm binaries).
 *
 * sharp: aliased to an empty shim (we only do text embeddings)
 * better-sqlite3: external (native binary)
 * @1password/sdk: external (lazy-loaded, optional dep)
 * onnxruntime-node: external (native binary, installed as dep)
 * @huggingface/transformers: external (native model loading)
 */

import { build } from "esbuild";

const EXTERNAL = ["better-sqlite3", "@1password/sdk", "onnxruntime-node", "@huggingface/transformers"];

const ALIAS: Record<string, string> = {
	sharp: "./src/shims/sharp.ts",
};

const targets: Array<{
	entrypoint: string;
	outfile: string;
}> = [
	{ entrypoint: "./src/daemon.ts", outfile: "./dist/daemon.js" },
	{ entrypoint: "./src/mcp-stdio.ts", outfile: "./dist/mcp-stdio.js" },
	{ entrypoint: "./src/index.ts", outfile: "./dist/index.js" },
	{ entrypoint: "./src/synthesis-render-worker.ts", outfile: "./dist/synthesis-render-worker.js" },
	{ entrypoint: "./src/pipeline/extraction-thread.ts", outfile: "./dist/extraction-thread.js" },
];

let ok = true;

for (const { entrypoint, outfile } of targets) {
	try {
		const aliasEntries = Object.entries(ALIAS).map(([k, v]) => [k, v]);
		await build({
			entryPoints: [entrypoint],
			bundle: true,
			outfile,
			platform: "node",
			target: "node20",
			external: EXTERNAL,
			alias: Object.fromEntries(aliasEntries),
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
