/**
 * Daemon build for the signetai meta-package — dual-runtime:
 * Bun.build under Bun, esbuild under Node.
 */

const EXTERNAL_BUN = ["better-sqlite3", "@1password/sdk", "onnxruntime-node", "@huggingface/transformers"];

const EXTERNAL_NODE = [
	"better-sqlite3",
	"bun",
	"bun:sqlite",
	"@1password/sdk",
	"onnxruntime-node",
	"@huggingface/transformers",
];

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

const forceNodeBuild = process.env.FORCE_NODE_BUILD === "1";
const isBun = typeof Bun !== "undefined" && !forceNodeBuild;
let ok = true;

if (isBun) {
	for (const { entrypoint, outfile } of targets) {
		const result = await Bun.build({
			entrypoints: [entrypoint],
			outdir: ".",
			naming: outfile,
			target: "bun",
			external: EXTERNAL_BUN,
			alias: ALIAS,
		});

		if (!result.success) {
			console.error(`Build failed: ${entrypoint}`);
			for (const log of result.logs) {
				console.error(log);
			}
			ok = false;
		} else {
			const size = result.outputs[0]?.size ?? 0;
			const mb = (size / 1024 / 1024).toFixed(1);
			console.log(`  ${outfile}  ${mb} MB`);
		}
	}
} else {
	const { build } = await import("esbuild");

	for (const { entrypoint, outfile } of targets) {
		try {
			await build({
				entryPoints: [entrypoint],
				bundle: true,
				outfile,
				platform: "node",
				target: "node20",
				external: EXTERNAL_NODE,
				alias: ALIAS,
				format: "esm",
				banner: {
					js: 'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
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
}

if (!ok) process.exit(1);
