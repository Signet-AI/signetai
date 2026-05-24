import type { SignetSourceEntry, SignetSourceKind } from "@signet/core";
import {
	type NativeMemorySource,
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
} from "./native-memory-sources";

export interface SourceProviderAdapter {
	readonly kind: SignetSourceKind;
	readonly toNativeSource: (source: SignetSourceEntry) => NativeMemorySource;
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
	return additionalProviders.get(kind);
}

export function configuredSourceProviders(): readonly SourceProviderAdapter[] {
	return [obsidianSourceProvider, ...additionalProviders.values()];
}
