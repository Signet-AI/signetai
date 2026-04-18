import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "skills");
const target = join(root, "packages/daemon/skills");

try {
	await access(source);
} catch (err) {
	console.error(`Skills source directory does not exist: ${source}`);
	if (err instanceof Error) {
		console.error(err.message);
	}
	process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true, force: true });
console.log(`Copied skills from ${source} to ${target}`);
