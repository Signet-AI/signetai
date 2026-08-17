import type { SignetSourceEntry, SignetSourceKind, SourceFailureState } from "@signet/core";
import { discordSourceProvider } from "./discord-source-provider";
import { githubSourceProvider } from "./github-source-provider";
import { markImportedSourceUnsupported } from "./imported-source-lifecycle";
import {
	type NativeMemorySource,
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
} from "./native-memory-sources";

export interface SourceProviderProgressEvent {
	readonly scanned: number;
	readonly total: number;
	readonly indexed: number;
	readonly currentPath: string;
}

export interface SourceProviderSyncContext {
	readonly source: SignetSourceEntry;
	readonly agentsDir: string;
	readonly agentId: string;
	readonly shouldContinue: () => boolean;
	readonly onProgress?: (event: SourceProviderProgressEvent) => void;
}

export interface SourceProviderSyncResult {
	readonly indexed: number;
	readonly scanned: number;
	readonly total: number;
	readonly failures: readonly SourceFailureState[];
}

export interface SourceProviderAdapter {
	readonly kind: SignetSourceKind;
	readonly toNativeSource?: (source: SignetSourceEntry) => NativeMemorySource;
	readonly sync?: (context: SourceProviderSyncContext) => Promise<SourceProviderSyncResult>;
	readonly purge: (source: SignetSourceEntry, agentId: string | undefined) => number | Promise<number>;
}

const additionalProviders = new Map<SignetSourceKind, SourceProviderAdapter>();

export const obsidianSourceProvider: SourceProviderAdapter = {
	kind: "obsidian",
	toNativeSource: (source) => obsidianNativeMemorySource(source.root, source.name, source.id, source.excludeGlobs),
	purge: (source, agentId) =>
		purgeNativeMemorySourceArtifacts(
			obsidianNativeMemorySource(source.root, source.name, source.id, source.excludeGlobs),
			agentId,
		),
};

export const importedSourceProvider: SourceProviderAdapter = {
	kind: "import",
	purge: async (source, agentId) =>
		(
			await markImportedSourceUnsupported({
				sourceId: source.id,
				agentId: agentId ?? "default",
			})
		).artifacts,
};

export function registerSourceProvider(provider: SourceProviderAdapter): void {
	additionalProviders.set(provider.kind, provider);
}

export function getSourceProvider(kind: SignetSourceKind): SourceProviderAdapter | undefined {
	if (kind === obsidianSourceProvider.kind) return obsidianSourceProvider;
	if (kind === discordSourceProvider.kind) return discordSourceProvider;
	if (kind === githubSourceProvider.kind) return githubSourceProvider;
	if (kind === importedSourceProvider.kind) return importedSourceProvider;
	return additionalProviders.get(kind);
}

export function configuredSourceProviders(): readonly SourceProviderAdapter[] {
	return [
		obsidianSourceProvider,
		discordSourceProvider,
		githubSourceProvider,
		importedSourceProvider,
		...additionalProviders.values(),
	];
}
