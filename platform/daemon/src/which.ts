import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

export function which(bin: string): string | null {
	if (isBun) {
		return (globalThis.Bun as { which(b: string): string | null }).which(bin);
	}

	if (isAbsolute(bin)) {
		try {
			accessSync(bin, constants.X_OK);
			return statSync(bin).isFile() ? bin : null;
		} catch {
			return null;
		}
	}

	const pathEnv = process.env.PATH ?? "";
	const pathSep = sep === "\\" ? ";" : ":";
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

	for (const dir of pathEnv.split(pathSep)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = resolve(dir, `${bin}${ext}`);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {}
		}
	}

	return null;
}
