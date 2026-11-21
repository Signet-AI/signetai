type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DISCOVERY_TIMEOUT_MS = 3_000;
const FAILURE_RETRY_MS = 60_000;

interface CacheEntry {
	readonly value: number | undefined;
	readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function versionedBase(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function rootOf(endpoint: string): string {
	return endpoint.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

async function getJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<unknown> {
	const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
	if (!response.ok) return undefined;
	return response.json();
}

function fromModelsList(body: unknown, model: string): number | undefined {
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) return undefined;
	const entry =
		data.find((item) => (item as { id?: unknown })?.id === model) ?? (data.length === 1 ? data[0] : undefined);
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { max_model_len?: unknown; meta?: { n_ctx?: unknown } };
	return positiveInt(record.max_model_len) ?? positiveInt(record.meta?.n_ctx);
}

function fromLlamaCppProps(body: unknown): number | undefined {
	const settings = (body as { default_generation_settings?: { n_ctx?: unknown } })?.default_generation_settings;
	return positiveInt(settings?.n_ctx) ?? positiveInt((body as { n_ctx?: unknown })?.n_ctx);
}

function fromOllamaShow(body: unknown): number | undefined {
	const parameters = (body as { parameters?: unknown })?.parameters;
	if (typeof parameters !== "string") return undefined;
	const match = /^num_ctx\s+(\d+)\s*$/m.exec(parameters);
	return match ? positiveInt(Number(match[1])) : undefined;
}

async function probe(
	executor: string,
	endpoint: string,
	model: string,
	apiKey: string | undefined,
	fetchImpl: FetchLike,
): Promise<number | undefined> {
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	if (executor === "ollama") {
		const shown = await getJson(fetchImpl, `${rootOf(endpoint)}/api/show`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		}).catch(() => undefined);
		return fromOllamaShow(shown);
	}
	const props = () => getJson(fetchImpl, `${rootOf(endpoint)}/props`, { headers }).catch(() => undefined);
	if (executor === "llama-cpp") {
		const fromProps = fromLlamaCppProps(await props());
		if (fromProps) return fromProps;
	}
	const listed = await getJson(fetchImpl, `${versionedBase(endpoint)}/models`, { headers }).catch(() => undefined);
	const fromList = fromModelsList(listed, model);
	if (fromList) return fromList;
	if (executor === "openai-compatible") return fromLlamaCppProps(await props());
	return undefined;
}

export async function discoverLocalContextWindow(
	executor: string,
	endpoint: string | undefined,
	model: string,
	apiKey?: string,
	fetchImpl: FetchLike = fetch,
	now: () => number = Date.now,
): Promise<number | undefined> {
	if (!endpoint) return undefined;
	const key = `${executor}|${endpoint}|${model}`;
	const cached = cache.get(key);
	if (cached && (cached.value !== undefined || cached.expiresAt > now())) return cached.value;
	let value: number | undefined;
	try {
		value = await probe(executor, endpoint, model, apiKey, fetchImpl);
	} catch {
		value = undefined;
	}
	cache.set(key, { value, expiresAt: now() + FAILURE_RETRY_MS });
	return value;
}

export function resetLocalContextWindowCache(): void {
	cache.clear();
}
