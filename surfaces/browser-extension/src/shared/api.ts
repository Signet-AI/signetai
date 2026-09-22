import { getConfig } from "./config.js";
import type {
	DaemonStatus,
	HealthResponse,
	Identity,
	Memory,
	MemoryStats,
	PipelineStatus,
	RecallResult,
	RememberRequest,
} from "./types.js";

async function getBaseUrl(): Promise<string> {
	const config = await getConfig();
	return config.daemonUrl;
}

async function getHeaders(): Promise<Record<string, string>> {
	const config = await getConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.authToken) {
		headers["Authorization"] = `Bearer ${config.authToken}`;
	}
	return headers;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T | null> {
	try {
		const base = await getBaseUrl();
		const headers = await getHeaders();
		const response = await fetch(`${base}${path}`, {
			...options,
			headers: { ...headers, ...options?.headers },
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

export async function checkHealth(): Promise<HealthResponse | null> {
	return fetchApi<HealthResponse>("/health");
}

export async function getStatus(): Promise<DaemonStatus | null> {
	return fetchApi<DaemonStatus>("/api/status");
}

export async function getIdentity(): Promise<Identity | null> {
	return fetchApi<Identity>("/api/identity");
}

export async function getPipelineStatus(): Promise<PipelineStatus | null> {
	return fetchApi<PipelineStatus>("/api/pipeline/status");
}

export async function getMemories(
	limit = 10,
	offset = 0,
): Promise<{ memories: readonly Memory[]; stats: MemoryStats }> {
	const result = await fetchApi<{ memories: Memory[]; stats: MemoryStats }>(
		`/api/memories?limit=${limit}&offset=${offset}`,
	);
	return result ?? { memories: [], stats: { total: 0, withEmbeddings: 0, critical: 0 } };
}

export async function recallMemories(query: string, limit = 10): Promise<RecallResult> {
	const result = await fetchApi<RecallResult>("/api/memory/recall", {
		method: "POST",
		body: JSON.stringify({ query, limit }),
	});
	return result ?? { memories: [], query, count: 0 };
}

export async function rememberMemory(request: RememberRequest): Promise<{ success: boolean; id?: string }> {
	const result = await fetchApi<{ success: boolean; id?: string }>("/api/memory/remember", {
		method: "POST",
		body: JSON.stringify(request),
	});
	return result ?? { success: false };
}
