import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGET = "wasm32-unknown-unknown";
const dashboard = resolve(import.meta.dir, "..");
const workspace = resolve(dashboard, "../app");
const output = join(dashboard, "src/lib/graph-layout.wasm");

function run(command: string, args: readonly string[]): string {
	const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	if (result.error)
		throw new Error(`[graph-layout] ${command} is required to build the graph layout kernel: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`[graph-layout] ${command} ${args.join(" ")} failed`);
	return result.stdout;
}

const sysroot = run("rustc", ["--print", "sysroot"]).trim();
if (!existsSync(join(sysroot, "lib", "rustlib", TARGET))) {
	console.log(`[graph-layout] installing the ${TARGET} Rust target`);
	run("rustup", ["target", "add", TARGET]);
}
run("cargo", ["build", "--release", "--locked", "--target", TARGET, "-p", "signet-graph-layout-wasm"]);
const targetDir = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"]))
	.target_directory as string;
copyFileSync(join(targetDir, TARGET, "release", "signet_graph_layout_wasm.wasm"), output);
console.log(`[graph-layout] wrote ${output}`);
