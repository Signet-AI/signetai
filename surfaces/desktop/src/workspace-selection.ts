import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseWorkspaceSelection, type WorkspaceSelection } from "./remote-workspace.js";

export async function loadWorkspaceSelection(path: string): Promise<WorkspaceSelection> {
	let data: string;
	try {
		data = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { mode: "local" };
		throw error;
	}
	const value: unknown = JSON.parse(data);
	return parseWorkspaceSelection(value);
}

export async function saveWorkspaceSelection(path: string, value: unknown): Promise<void> {
	const selection = parseWorkspaceSelection(value);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(selection), { mode: 0o600 });
	await rename(temporary, path);
}
