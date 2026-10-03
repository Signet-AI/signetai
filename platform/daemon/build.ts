import { rmSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { EXTERNAL_BUN, EXTERNAL_NODE } from "./build-externals";
import { RuntimeManifest, runtimeReferences } from "./build-manifest/build";

process.chdir(import.meta.dir);

const ALIAS: Record<string, string> = {
	sharp: "./src/shims/sharp.ts",
};

const forceNodeBuild = process.env.FORCE_NODE_BUILD === "1";
const root = resolve(import.meta.dir, "../..");
const referenced = new Set<string>();
const manifest = new RuntimeManifest(root);
function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") && !/\.(test|spec|bench)\.ts$/.test(entry.name) ? [path] : [];
	});
}
const sources = [...sourceFiles(join(root, "platform/daemon/src")), ...sourceFiles(join(root, "platform/core/src"))];
const targets = ["daemon", "mcp-stdio", "index"].map((name) => ({
	entrypoint: `./src/${name}.ts`,
	outfile: `./dist/${name}.js`,
}));
for (const name of new Set(sources.flatMap(runtimeReferences).filter((name) => /\.[cm]?js$/.test(name)))) {
	if (targets.some((target) => target.outfile === `./dist/${name}`)) continue;
	const matches = sources.filter((path) =>
		path.replaceAll("\\", "/").endsWith(`/${name.replace(/\.[cm]?js$/, ".ts")}`),
	);
	if (matches.length !== 1) throw new Error(`Missing or ambiguous runtime asset producer: ${name}`);
	const entrypoint = matches[0];
	if (entrypoint) targets.push({ entrypoint, outfile: `./dist/${name}` });
}
for (const name of forceNodeBuild ? [] : ["workspace-migration-runner", "runtime-diagnostics"]) {
	targets.push({ entrypoint: join(root, "surfaces/desktop/scripts", `${name}.ts`), outfile: `./dist/${name}.js` });
}
const profileBuild = process.env.SIGNET_DAEMON_PROFILE === "1" || process.argv.includes("--profile");
if (!profileBuild) {
	for (const target of targets) rmSync(`${target.outfile}.map`, { force: true });
}
const isBun = typeof Bun !== "undefined" && !forceNodeBuild;
let ok = true;

if (isBun) {
	for (const { entrypoint, outfile } of targets) {
		const result = await Bun.build({
			entrypoints: [entrypoint],
			metafile: true,
			plugins: [
				manifest.plugin({
					output: resolve(outfile),
					directory: join(import.meta.dir, "dist"),
					aliases: ALIAS,
					external: EXTERNAL_BUN,
				}),
			],
			outdir: ".",
			naming: {
				entry: outfile,
				asset: "dist/[name].[ext]",
			},
			target: "bun",
			format: "esm",
			external: EXTERNAL_BUN,
			alias: ALIAS,
			sourcemap: profileBuild ? "external" : "none",
		});

		if (!result.success) {
			console.error(`Build failed: ${entrypoint}`);
			for (const log of result.logs) {
				console.error(log);
			}
			ok = false;
		} else {
			if (!result.metafile) throw new Error("Runtime build metafile is missing");
			for (const name of manifest.graph(result.metafile, process.cwd())) referenced.add(name);
			for (const output of result.outputs)
				manifest.add(
					resolve(output.path),
					`dist/${relative(join(import.meta.dir, "dist"), resolve(output.path))
						.split(sep)
						.join("/")}`,
				);
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
				loader: { ".wasm": "file" },
				assetNames: "[name]",
				format: "esm",
				sourcemap: profileBuild ? "external" : false,
				banner: {
					js: 'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
				},
				logLevel: "warning",
			});

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
if (!forceNodeBuild) {
	for (const name of referenced) manifest.require(`dist/${name}`);
	manifest.tree(join(root, "platform/daemon/dashboard"), "dashboard");
	manifest.tree(join(root, "platform/daemon/skills"), "skills");
	manifest.tree(
		join(root, "integrations/hermes-agent/connector/hermes-plugin"),
		"connectors/hermes-agent/hermes-plugin",
	);
	manifest.materialize(import.meta.dir);
	manifest.write(join(root, "platform/daemon/dist/runtime-manifest.json"));
}
