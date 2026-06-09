/**
 * Signet Sessions source provider — indexes per-session notes files
 * written by the session-notes-writer pipeline stage.
 *
 * The provider maps a `signet-sessions` source entry onto a
 * `NativeMemorySource` whose only pattern is the recursive glob for
 * `notes.md` under the session directory, so the existing native-memory
 * bridge walks the session directory and indexes each `notes.md` file
 * as a source artifact.
 *
 * Source files are never deleted by `purge` — they are the source of
 * truth for the session. Only the derived FTS, embedding, and graph
 * rows are removed, mirroring AGENTS.md's "raw source artifacts must
 * not be rewritten" rule.
 */

import type { SignetSourceEntry } from "@signet/core";
import { addSignetSessionsSource } from "@signet/core";
import { logger } from "./logger";
import { type NativeMemorySource, purgeNativeMemorySourceArtifacts } from "./native-memory-sources";
import type { SourceProviderAdapter } from "./source-providers";

function signetSessionsNativeMemorySource(source: SignetSourceEntry): NativeMemorySource {
	return {
		harness: "signet-sessions",
		displayName: source.name,
		root: source.root,
		sourceId: source.id,
		files: [
			{
				glob: "**/notes.md",
				kind: "signet_session_notes",
			},
		],
	};
}

export const signetSessionsSourceProvider: SourceProviderAdapter = {
	kind: "signet-sessions",
	toNativeSource: (source) => signetSessionsNativeMemorySource(source),
	purge: (source, agentId) => {
		const removed = purgeNativeMemorySourceArtifacts(signetSessionsNativeMemorySource(source), agentId);
		logger.info("sources", "Purged signet-sessions derived artifacts", {
			sourceId: source.id,
			root: source.root,
			agentId: agentId ?? "(all)",
			removed,
		});
		return removed;
	},
};

/**
 * Idempotently ensure a `signet-sessions` source entry exists in
 * `sources.json`. Safe to call on every daemon startup — re-runs are
 * a no-op when the entry already exists. Returns the resulting source
 * entry or, on hard failure, logs a warning and returns null.
 */
export function ensureSignetSessionsSourceRegistered(agentsDir: string): SignetSourceEntry | null {
	const result = addSignetSessionsSource({}, agentsDir);
	if (result.ok) return result.source;
	logger.warn("sources", "Failed to ensure signet-sessions source registration", {
		error: result.error,
	});
	return null;
}
