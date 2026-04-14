export function resolveRuntimeModel(effective: string, configured: string, model?: string): string | undefined {
	return (effective === "ollama" || effective === "llama-cpp") && configured !== effective ? undefined : model;
}
