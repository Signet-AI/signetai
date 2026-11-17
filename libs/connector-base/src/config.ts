import { statSync } from "node:fs";

export type ResolvedCommand = {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
};

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTrimmedEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().replace(/[\r\n]+/g, "");
	return trimmed.length > 0 ? trimmed : undefined;
}

export function readManagedTrimmedEnv(name: string): string | undefined {
	return readTrimmedEnv(name);
}

export function isExistingFile(path: string | undefined): path is string {
	if (!path) return false;
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
