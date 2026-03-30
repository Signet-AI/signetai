import { readPipelineConfigData, readPipelinePauseState, setPipelinePaused } from "@signet/core";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_EXTRACTION_MODEL = "qwen3.5:4b";
const DEFAULT_SYNTHESIS_MODEL = "qwen3:4b";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text-v1.5";

export { readPipelinePauseState, setPipelinePaused };
export type { PipelinePauseState } from "@signet/core";

export interface OllamaReleaseTarget {
	readonly baseUrl: string;
	readonly label: "embedding" | "extraction" | "synthesis";
	readonly model: string;
}

export interface OllamaReleaseResult extends OllamaReleaseTarget {
	readonly error?: string;
	readonly ok: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimText(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	return text.length > 0 ? text : undefined;
}

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function normalizeUrl(raw: unknown, fallback: string): string {
	const text = trimText(raw);
	const url = trimSlash(text ?? fallback);

	try {
		const parsed = new URL(url);
		if (parsed.hostname === "0.0.0.0") {
			parsed.hostname = "127.0.0.1";
			return trimSlash(parsed.toString());
		}

		if (parsed.hostname === "::" || parsed.hostname === "[::]") {
			const auth =
				parsed.username.length > 0
					? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ""}@`
					: "";
			const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
			return trimSlash(`${parsed.protocol}//${auth}[::1]${port}${parsed.pathname}${parsed.search}${parsed.hash}`);
		}

		return trimSlash(parsed.toString());
	} catch {
		return url;
	}
}

function isLoopback(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "localhost" ||
			parsed.hostname === "::1" ||
			parsed.hostname === "[::1]"
		);
	} catch {
		return false;
	}
}

function addTarget(
	list: OllamaReleaseTarget[],
	seen: Set<string>,
	label: OllamaReleaseTarget["label"],
	model: string,
	baseUrl: string,
): void {
	if (!isLoopback(baseUrl)) return;
	const key = [baseUrl, model].join("\u0000");
	if (seen.has(key)) return;
	seen.add(key);
	list.push({ label, model, baseUrl });
}

export function readOllamaReleaseTargets(dir: string): readonly OllamaReleaseTarget[] {
	const { root, memory, pipeline } = readPipelineConfigData(dir);
	if (root === null) return [];

	const out: OllamaReleaseTarget[] = [];
	const seen = new Set<string>();

	const extraction = pipeline && isObject(pipeline.extraction) ? pipeline.extraction : null;
	if (extraction?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"extraction",
			trimText(extraction.model) ?? DEFAULT_EXTRACTION_MODEL,
			normalizeUrl(extraction.endpoint ?? extraction.base_url, DEFAULT_OLLAMA_URL),
		);
	}

	const synthesis = pipeline && isObject(pipeline.synthesis) ? pipeline.synthesis : null;
	if (synthesis?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"synthesis",
			trimText(synthesis.model) ?? DEFAULT_SYNTHESIS_MODEL,
			normalizeUrl(synthesis.endpoint ?? synthesis.base_url, DEFAULT_OLLAMA_URL),
		);
	}

	const embedding = isObject(root.embedding)
		? root.embedding
		: memory && isObject(memory.embeddings)
			? memory.embeddings
			: isObject(root.embeddings)
				? root.embeddings
				: null;
	if (embedding?.provider === "ollama") {
		addTarget(
			out,
			seen,
			"embedding",
			trimText(embedding.model) ?? DEFAULT_EMBEDDING_MODEL,
			normalizeUrl(embedding.base_url ?? embedding.endpoint ?? embedding.url, DEFAULT_OLLAMA_URL),
		);
	}

	return out;
}

export async function releaseOllamaModels(
	dir: string,
	doFetch: typeof fetch = fetch,
): Promise<readonly OllamaReleaseResult[]> {
	const targets = readOllamaReleaseTargets(dir);
	const out: OllamaReleaseResult[] = [];

	for (const target of targets) {
		try {
			const res = await doFetch(`${target.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: target.model,
					keep_alive: 0,
				}),
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				out.push({
					...target,
					ok: false,
					error: body ? `HTTP ${res.status}: ${body.slice(0, 200)}` : `HTTP ${res.status}`,
				});
				continue;
			}

			out.push({ ...target, ok: true });
		} catch (err) {
			out.push({
				...target,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return out;
}
