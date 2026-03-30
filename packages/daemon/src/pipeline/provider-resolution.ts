export function resolveRuntimeModel(effective: string, configured: string, model?: string): string | undefined {
	return effective === "ollama" && configured !== "ollama" ? undefined : model;
}
