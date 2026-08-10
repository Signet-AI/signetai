import type { AgentConfigStore } from "./agent-config";

type EmbeddingConfigStore = Pick<AgentConfigStore, "aDel" | "aSetStr" | "aStr">;

export function readEmbeddingEndpoint(store: Pick<EmbeddingConfigStore, "aStr">, path: readonly string[]): string {
	return store.aStr([...path, "base_url"]) || store.aStr([...path, "baseUrl"]) || store.aStr([...path, "endpoint"]);
}

export function writeEmbeddingEndpoint(
	store: Pick<EmbeddingConfigStore, "aDel" | "aSetStr">,
	path: readonly string[],
	value: string,
): void {
	store.aSetStr([...path, "base_url"], value);
	store.aDel([...path, "baseUrl"]);
	store.aDel([...path, "endpoint"]);
}
