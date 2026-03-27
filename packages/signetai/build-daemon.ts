/**
 * Daemon build for the signetai meta-package — mirrors
 * packages/daemon/build.ts with the same externals and aliases.
 */

const EXTERNAL = [
	"better-sqlite3",
	"@1password/sdk",
	"onnxruntime-node",
	"@huggingface/transformers",
];

const ALIAS = {
	sharp: "../daemon/src/shims/sharp.ts",
};

const targets: Array<{
	entrypoint: string;
	outfile: string;
}> = [
	{ entrypoint: "../daemon/src/daemon.ts", outfile: "./dist/daemon.js" },
	{ entrypoint: "../daemon/src/mcp-stdio.ts", outfile: "./dist/mcp-stdio.js" },
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
