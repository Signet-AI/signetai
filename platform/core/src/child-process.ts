import {
	execFile as nodeExecFile,
	execFileSync as nodeExecFileSync,
	execSync as nodeExecSync,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
} from "node:child_process";
import { promisify } from "node:util";

export type { ChildProcess, ChildProcessWithoutNullStreams, SpawnSyncReturns } from "node:child_process";

type ProcessOptions = {
	readonly windowsHide?: boolean | undefined;
	readonly shell?: boolean | string | undefined;
};

/**
 * Apply Signet's default for child-process console visibility.
 *
 * Callers may explicitly opt into a visible child for an interactive tool,
 * but background and helper processes must not create a second Windows
 * console by default.
 */
export function withWindowsHide<T extends ProcessOptions>(
	options: T | null | undefined,
): T & { readonly windowsHide: boolean } {
	return {
		...(options ?? {}),
		windowsHide: options?.windowsHide ?? true,
	} as T & { readonly windowsHide: boolean };
}

function isOptions(value: unknown): value is ProcessOptions {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withWindowsHideArgument(args: readonly unknown[], firstOptionIndex: number): unknown[] {
	const normalized = [...args];
	const optionIndex = normalized.findIndex((value, index) => index >= firstOptionIndex && isOptions(value));
	if (optionIndex >= 0) {
		normalized[optionIndex] = withWindowsHide(normalized[optionIndex]);
		return normalized;
	}

	const placeholderIndex = normalized.findIndex(
		(value, index) => index >= firstOptionIndex && (value === undefined || value === null),
	);
	if (placeholderIndex >= 0) {
		normalized[placeholderIndex] = withWindowsHide(undefined);
		return normalized;
	}

	const callbackIndex = normalized.findIndex(
		(value, index) => index >= firstOptionIndex && typeof value === "function",
	);
	normalized.splice(callbackIndex >= 0 ? callbackIndex : normalized.length, 0, { windowsHide: true });
	return normalized;
}

function withSpawnDefaults(
	options: ProcessOptions | null | undefined,
): ProcessOptions & { readonly windowsHide: boolean } {
	if (options?.shell !== undefined && options.shell !== false) {
		throw new TypeError("spawnHidden does not allow shell execution");
	}
	return {
		...withWindowsHide(options),
		shell: false,
	};
}

export const spawnHidden: typeof nodeSpawn = ((
	command: string,
	argsOrOptions?: readonly string[] | ProcessOptions,
	options?: ProcessOptions,
) => {
	if (Array.isArray(argsOrOptions)) return nodeSpawn(command, argsOrOptions, withSpawnDefaults(options));
	return nodeSpawn(command, withSpawnDefaults(options ?? (argsOrOptions as ProcessOptions | undefined)));
}) as typeof nodeSpawn;

export const spawnSyncHidden: typeof nodeSpawnSync = ((
	command: string,
	argsOrOptions?: readonly string[] | ProcessOptions,
	options?: ProcessOptions,
) => {
	if (Array.isArray(argsOrOptions)) return nodeSpawnSync(command, argsOrOptions, withSpawnDefaults(options));
	return nodeSpawnSync(command, withSpawnDefaults(options ?? (argsOrOptions as ProcessOptions | undefined)));
}) as typeof nodeSpawnSync;

const nodeExecFileAsync = promisify(nodeExecFile);

const execFileHiddenImpl = ((...args: unknown[]) =>
	Reflect.apply(nodeExecFile, undefined, withWindowsHideArgument(args, 1))) as typeof nodeExecFile;
Object.defineProperty(execFileHiddenImpl, promisify.custom, {
	value: (...args: unknown[]) => Reflect.apply(nodeExecFileAsync, undefined, withWindowsHideArgument(args, 1)),
});
export const execFileHidden = execFileHiddenImpl;

export const execSyncHidden: typeof nodeExecSync = ((...args: unknown[]) =>
	Reflect.apply(nodeExecSync, undefined, withWindowsHideArgument(args, 1))) as typeof nodeExecSync;

export const execFileSyncHidden: typeof nodeExecFileSync = ((...args: unknown[]) =>
	Reflect.apply(nodeExecFileSync, undefined, withWindowsHideArgument(args, 1))) as typeof nodeExecFileSync;
