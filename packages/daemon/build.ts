/**
 * Daemon build script — uses Bun.build() to alias native packages
 * that break when bundled (baked paths to .node/.wasm binaries).
 *
 * sharp: aliased to an empty shim (we only do text embeddings)
 * better-sqlite3: external (node-only fallback in @signet/core)
 * @1password/sdk: external (lazy-loaded, optional dep)
 * onnxruntime-node: external (native binary, installed as dep)
 */

const EXTERNAL = [
	"better-sqlite3",
	"@1password/sdk",
	"onnxruntime-node",
	"@huggingface/transformers",
];

const ALIAS = {
	sharp: "./src/shims/sharp.ts",
};

const targets: Array<{
	entrypoint: string;
	outfile: string;
}> = [
	{ entrypoint: "./src/daemon.ts", outfile: "./dist/daemon.js" },
	{ entrypoint: "./src/mcp-stdio.ts", outfile: "./dist/mcp-stdio.js" },
	{ entrypoint: "./src/index.ts", outfile: "./dist/index.js" },
];

let ok = true;

for (const { entrypoint, outfile } of targets) {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir: ".",
		naming: outfile,
		target: "bun",
		external: EXTERNAL,
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

if (!ok) process.exit(1);
