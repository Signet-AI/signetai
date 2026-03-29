export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readRuntimeEnv(name: string): string | undefined {
	const runtimeProcess = Reflect.get(globalThis, "process");
	if (!isRecord(runtimeProcess)) return undefined;
	const runtimeEnv = Reflect.get(runtimeProcess, "env");
	if (!isRecord(runtimeEnv)) return undefined;
	const value = Reflect.get(runtimeEnv, name);
	return typeof value === "string" ? value : undefined;
}

export function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function readTrimmedRuntimeEnv(name: string): string | undefined {
	return readTrimmedString(readRuntimeEnv(name));
}
