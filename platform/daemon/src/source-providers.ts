import type { SignetSourceEntry, SignetSourceKind, SourceFailureState } from "@signetai/core";
import { discordSourceProvider } from "./discord-source-provider";
import { githubSourceProvider } from "./github-source-provider";
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
	readonly purge: (source: SignetSourceEntry, agentId: string | undefined) => number;
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

export function registerSourceProvider(provider: SourceProviderAdapter): void {
	additionalProviders.set(provider.kind, provider);
}

export function getSourceProvider(kind: SignetSourceKind): SourceProviderAdapter | undefined {
	if (kind === obsidianSourceProvider.kind) return obsidianSourceProvider;
	if (kind === discordSourceProvider.kind) return discordSourceProvider;
	if (kind === githubSourceProvider.kind) return githubSourceProvider;
	return additionalProviders.get(kind);
}

export function configuredSourceProviders(): readonly SourceProviderAdapter[] {
	return [obsidianSourceProvider, discordSourceProvider, githubSourceProvider, ...additionalProviders.values()];
}
