import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

function isExecutableFile(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function hasPathSeparator(bin: string): boolean {
	return bin.includes("/") || (sep === "\\" && bin.includes("\\"));
}

export function whichWithoutBun(bin: string, pathEnv = process.env.PATH ?? ""): string | null {
	if (isAbsolute(bin) || hasPathSeparator(bin)) {
		const candidate = resolve(bin);
		return isExecutableFile(candidate) ? candidate : null;
	}

	const pathSep = sep === "\\" ? ";" : ":";
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

	for (const dir of pathEnv.split(pathSep)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = resolve(dir, `${bin}${ext}`);
			if (isExecutableFile(candidate)) return candidate;
		}
	}

	return null;
}

export function which(bin: string): string | null {
	if (isBun) {
		return (globalThis.Bun as { which(b: string): string | null }).which(bin);
	}

	return whichWithoutBun(bin);
}
