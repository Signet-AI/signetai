import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(import.meta.dir, "dist");
await rm(output, { recursive: true, force: true });
const external = ["react", "zod", "@signet/core/*"];
const browser = await Bun.build({
	entrypoints: [
		"./src/index.ts",
		"./src/errors.ts",
		"./src/transport.ts",
		"./src/react.tsx",
		"./src/ai-sdk.ts",
		"./src/openai.ts",
	].map((path) => resolve(import.meta.dir, path)),
	outdir: output,
	target: "browser",
	splitting: true,
	external,
});
if (!browser.success) throw new AggregateError(browser.logs, "SDK browser build failed");
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const transpiler = new Bun.Transpiler({ target: "node", loader: "ts" });
await mkdir(join(output, "node"), { recursive: true });
await writeFile(
	join(output, "node.js"),
	transpiler.transformSync(await readFile(resolve(import.meta.dir, "src/node.ts"), "utf8")),
);
for (const file of await readdir(resolve(import.meta.dir, "src/node"))) {
	if (!file.endsWith(".ts")) continue;
	await writeFile(
		join(output, "node", file.replace(/\.ts$/, ".js")),
		transpiler.transformSync(await readFile(resolve(import.meta.dir, "src/node", file), "utf8")),
	);
}
