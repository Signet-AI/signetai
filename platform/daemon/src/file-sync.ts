import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
export function writeFileIfChanged(path: string, content: string): boolean {
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
	if (existing === content) return false;
	writeFileSync(path, content);
	return true;
}
export async function writeFileIfChangedAsync(path: string, content: string): Promise<boolean> {
	let existing: string | null = null;
	try {
		existing = await readFile(path, "utf-8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") {
			throw error;
		}
	}
	if (existing === content) return false;
	await writeFile(path, content, "utf-8");
	return true;
}
