import type { SignetSourceEntry, SignetSourceKind, SourceFailureState } from "@signet/core";
import { discordSourceProvider } from "./discord-source-provider";
import { githubSourceProvider } from "./github-source-provider";
import { webSourceProvider } from "./web-source-provider";
import { markImportedSourceUnsupported } from "./imported-source-lifecycle";
import {
	configuredFilesystemNativeMemorySource,
	type NativeMemorySource,
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

function nativeFilesystemSourceProvider(kind: "local-files" | "obsidian"): SourceProviderAdapter {
	return {
		kind,
		toNativeSource: configuredFilesystemNativeMemorySource,
		purge: (source, agentId) =>
			purgeNativeMemorySourceArtifacts(configuredFilesystemNativeMemorySource(source), agentId),
	};
}

export const obsidianSourceProvider = nativeFilesystemSourceProvider("obsidian");

export const localFilesSourceProvider = nativeFilesystemSourceProvider("local-files");

export const importedSourceProvider: SourceProviderAdapter = {
	kind: "import",
	purge: (source, agentId) =>
		markImportedSourceUnsupported({
			sourceId: source.id,
			agentId: agentId ?? "default",
		}).artifacts,
};

const builtInProviders = new Map<SignetSourceKind, SourceProviderAdapter>(
	[
		localFilesSourceProvider,
		obsidianSourceProvider,
		discordSourceProvider,
		githubSourceProvider,
		webSourceProvider,
		importedSourceProvider,
	].map((provider) => [provider.kind, provider]),
);

export function registerSourceProvider(provider: SourceProviderAdapter): void {
	additionalProviders.set(provider.kind, provider);
}

export function getSourceProvider(kind: SignetSourceKind): SourceProviderAdapter | undefined {
	return builtInProviders.get(kind) ?? additionalProviders.get(kind);
}

export function configuredSourceProviders(): readonly SourceProviderAdapter[] {
	return [...builtInProviders.values(), ...additionalProviders.values()];
}
