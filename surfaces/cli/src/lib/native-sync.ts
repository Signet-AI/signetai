import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseSimpleYaml } from "@signetai/core";
import { sleep } from "./runtime.js";

const NATIVE_SYNC_LOCK_FILENAME = "sync-native.lock";

type EmbeddingProvider = "native" | "llama-cpp" | "ollama" | "openai" | "none";

const VALID_PROVIDERS: readonly EmbeddingProvider[] = ["native", "llama-cpp", "ollama", "openai", "none"];

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function embeddingProvider(basePath: string): EmbeddingProvider {
	const paths = ["agent.yaml", "AGENT.yaml", "config.yaml"].map((name) => join(basePath, name));
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = parseSimpleYaml(readFileSync(path, "utf-8"));
			if (!isRecord(parsed)) continue;
			const direct = parsed.embedding;
			if (isRecord(direct) && typeof direct.provider === "string") {
				const provider = direct.provider;
				if ((VALID_PROVIDERS as readonly string[]).includes(provider)) {
					return provider as EmbeddingProvider;
				}
			}
			const mem = parsed.memory;
			if (isRecord(mem)) {
				const nested = mem.embeddings;
				if (isRecord(nested) && typeof nested.provider === "string") {
					const provider = nested.provider;
					if ((VALID_PROVIDERS as readonly string[]).includes(provider)) {
						return provider as EmbeddingProvider;
					}
				}
			}
			const legacy = parsed.embeddings;
			if (isRecord(legacy) && typeof legacy.provider === "string") {
				const provider = legacy.provider;
				if ((VALID_PROVIDERS as readonly string[]).includes(provider)) {
					return provider as EmbeddingProvider;
				}
			}
		} catch {
			// Malformed config — keep scanning fallbacks.
		}
	}
	return "native";
}

export function hasNativeModelCache(basePath: string): boolean {
	const dir = join(basePath, ".models");
	if (!existsSync(dir)) {
		return false;
	}
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function nativeSyncLockPath(basePath: string): string {
	return join(basePath, ".daemon", NATIVE_SYNC_LOCK_FILENAME);
}

function clearStaleNativeSyncLock(path: string): boolean {
	try {
		const raw = readFileSync(path, "utf-8");
		const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
		if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) {
			rmSync(path, { force: true });
			return true;
		}
	} catch {
		// Best-effort stale-lock detection.
	}

	try {
		const age = Date.now() - statSync(path).mtimeMs;
		if (age > 5 * 60_000) {
			rmSync(path, { force: true });
			return true;
		}
	} catch {
		// Lock disappeared between checks.
	}

	return false;
}

export async function acquireNativeSyncLock(basePath: string): Promise<{
	readonly fd: number;
	readonly path: string;
} | null> {
	const path = nativeSyncLockPath(basePath);
	mkdirSync(dirname(path), { recursive: true });
	const end = Date.now() + 15_000;

	while (Date.now() < end) {
		try {
			const fd = openSync(path, "wx");
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			return { fd, path };
		} catch (err) {
			const code = err instanceof Error && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				return null;
			}
		}

		if (clearStaleNativeSyncLock(path)) {
			continue;
		}

		await sleep(200);
	}

	return null;
}

export function releaseNativeSyncLock(lock: { readonly fd: number; readonly path: string }): void {
	try {
		closeSync(lock.fd);
	} catch {
		// Ignore.
	}
	rmSync(lock.path, { force: true });
}
