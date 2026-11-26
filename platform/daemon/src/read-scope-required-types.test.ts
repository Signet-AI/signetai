import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const SRC = import.meta.dir;

const header = `
import type { ReadScope } from "${SRC}/read-scope";
import { localAllReadScope } from "${SRC}/read-scope";
import { hybridRecall, recallScopes, buildSourceChunkVectorHits, prefetchTranscriptEvidence } from "${SRC}/memory-search";
import { buildMemorySearchFilterClause } from "${SRC}/memory-search-filters";
import { resolveTemporalRecall } from "${SRC}/temporal-recall";
import { aggregateRecall } from "${SRC}/aggregate-recall";
import { isDuplicate } from "${SRC}/memory-classification";
import { constructContextBlocksViaOwner } from "${SRC}/pipeline/context-construction";
import { createEmbeddingReranker } from "${SRC}/pipeline/reranker-embedding";
import {
	scoreStructuredPathEvidence,
	findStructuredPathCandidates,
	findStructuredClaimCandidates,
	findStructuredPathCandidatesViaOwner,
	scoreStructuredPathEvidenceViaOwner,
	findStructuredClaimCandidatesViaOwner,
} from "${SRC}/pipeline/structured-path-evidence";
import { handleSessionStart, handlePreCompaction, handleUserPromptSubmit } from "${SRC}/hooks";
import { vectorSearchThroughDbOwner } from "${SRC}/db-owner-recall";
import { applyRecallDedupeAsync, claimRecallItemsAsync } from "${SRC}/session-recall-dedupe";
import { internalHookReadScope } from "${SRC}/hook-read-scope";
declare const scope: ReadScope;
declare const cfg: Parameters<typeof hybridRecall>[1];
declare const embed: Parameters<typeof hybridRecall>[2];
declare const aggregateDeps: Parameters<typeof aggregateRecall>[2];
declare const dupDb: Parameters<typeof isDuplicate>[0];
declare const owner: Parameters<typeof constructContextBlocksViaOwner>[0];
declare const accessor: Parameters<typeof createEmbeddingReranker>[0];
declare const readDb: Parameters<typeof scoreStructuredPathEvidence>[0];
declare const pathOwner: Parameters<typeof findStructuredPathCandidatesViaOwner>[0];
declare const recallOwner: Parameters<typeof vectorSearchThroughDbOwner>[0];
declare const embedding: Parameters<typeof buildSourceChunkVectorHits>[4];
declare const sessionStart: Parameters<typeof handleSessionStart>[0];
declare const preCompaction: Parameters<typeof handlePreCompaction>[0];
declare const promptSubmit: Parameters<typeof handleUserPromptSubmit>[0];
declare const dedupeBase: Omit<Parameters<typeof applyRecallDedupeAsync>[0], "readScope">;
declare const claimBase: Omit<Parameters<typeof claimRecallItemsAsync>[0], "readScope">;
`;

interface ProbeCase {
	readonly name: string;
	readonly omitted: string;
	readonly provided: string;
}

const cases: readonly ProbeCase[] = [
	{
		name: "localAllReadScope",
		omitted: "localAllReadScope();",
		provided: 'localAllReadScope({ kind: "own", agentId: "a" });',
	},
	{
		name: "internalHookReadScope",
		omitted: "internalHookReadScope();",
		provided: 'void internalHookReadScope("a");',
	},
	{
		name: "hybridRecall",
		omitted: 'void hybridRecall({ query: "q", agentId: "a" }, cfg, embed);',
		provided: 'void hybridRecall({ query: "q", agentId: "a", readScope: scope }, cfg, embed);',
	},
	{
		name: "recallScopes",
		omitted: 'recallScopes({ agentId: "a" });',
		provided: 'recallScopes({ agentId: "a", readScope: scope });',
	},
	{
		name: "buildMemorySearchFilterClause",
		omitted: 'buildMemorySearchFilterClause({ agentId: "a" });',
		provided: 'buildMemorySearchFilterClause({ agentId: "a", readScope: scope });',
	},
	{
		name: "resolveTemporalRecall",
		omitted: 'resolveTemporalRecall({ query: "q", limit: 5, agentId: "a" });',
		provided: 'resolveTemporalRecall({ query: "q", limit: 5, agentId: "a", readScope: scope });',
	},
	{
		name: "aggregateRecall",
		omitted: 'void aggregateRecall({ query: "q", agentId: "a" }, cfg, aggregateDeps);',
		provided: 'void aggregateRecall({ query: "q", agentId: "a", readScope: scope }, cfg, aggregateDeps);',
	},
	{
		name: "isDuplicate",
		omitted: 'isDuplicate(dupDb, "content", "a");',
		provided: 'isDuplicate(dupDb, "content", "a", scope);',
	},
	{
		name: "constructContextBlocksViaOwner",
		omitted: 'void constructContextBlocksViaOwner(owner, "a", ["e"], 5);',
		provided: 'void constructContextBlocksViaOwner(owner, "a", ["e"], 5, undefined, true, scope);',
	},
	{
		name: "createEmbeddingReranker",
		omitted: "createEmbeddingReranker(accessor, new Float32Array(1));",
		provided: "createEmbeddingReranker(accessor, new Float32Array(1), scope);",
	},
	{
		name: "scoreStructuredPathEvidence",
		omitted: 'scoreStructuredPathEvidence(readDb, ["m"], "q", "a");',
		provided: 'scoreStructuredPathEvidence(readDb, ["m"], "q", "a", scope);',
	},
	{
		name: "findStructuredPathCandidates",
		omitted: 'findStructuredPathCandidates(readDb, "q", "a", { limit: 5 });',
		provided: 'findStructuredPathCandidates(readDb, "q", "a", { limit: 5, readScope: scope });',
	},
	{
		name: "findStructuredPathCandidates default options",
		omitted: 'findStructuredPathCandidates(readDb, "q", "a");',
		provided: 'findStructuredPathCandidates(readDb, "q", "a", { limit: 20, readScope: scope });',
	},
	{
		name: "findStructuredClaimCandidates",
		omitted: 'findStructuredClaimCandidates(readDb, "q", "a");',
		provided: 'findStructuredClaimCandidates(readDb, "q", "a", { limit: 5, readScope: scope });',
	},
	{
		name: "findStructuredPathCandidatesViaOwner",
		omitted: 'void findStructuredPathCandidatesViaOwner(pathOwner, "q", "a", { limit: 5 });',
		provided: 'void findStructuredPathCandidatesViaOwner(pathOwner, "q", "a", { limit: 5, readScope: scope });',
	},
	{
		name: "scoreStructuredPathEvidenceViaOwner",
		omitted: 'void scoreStructuredPathEvidenceViaOwner(pathOwner, ["m"], "q", "a");',
		provided: 'void scoreStructuredPathEvidenceViaOwner(pathOwner, ["m"], "q", "a", scope);',
	},
	{
		name: "findStructuredClaimCandidatesViaOwner",
		omitted: 'void findStructuredClaimCandidatesViaOwner(pathOwner, "q", "a", { limit: 5 });',
		provided: 'void findStructuredClaimCandidatesViaOwner(pathOwner, "q", "a", { limit: 5, readScope: scope });',
	},
	{
		name: "buildSourceChunkVectorHits",
		omitted: 'void buildSourceChunkVectorHits(null, new Set(), 5, "a", embedding);',
		provided: 'void buildSourceChunkVectorHits(null, new Set(), 5, "a", embedding, undefined, undefined, scope);',
	},
	{
		name: "prefetchTranscriptEvidence",
		omitted: 'void prefetchTranscriptEvidence(undefined, {}, "q", 5, 5, Date.now(), undefined);',
		provided: 'void prefetchTranscriptEvidence(undefined, {}, "q", 5, 5, Date.now(), undefined, scope);',
	},
	{
		name: "handleSessionStart",
		omitted: "void handleSessionStart(sessionStart);",
		provided: "void handleSessionStart(sessionStart, scope);",
	},
	{
		name: "handlePreCompaction",
		omitted: "void handlePreCompaction(preCompaction);",
		provided: "void handlePreCompaction(preCompaction, scope);",
	},
	{
		name: "handleUserPromptSubmit",
		omitted: "void handleUserPromptSubmit(promptSubmit, undefined, {});",
		provided: "void handleUserPromptSubmit(promptSubmit, undefined, { readScope: scope });",
	},
	{
		name: "handleUserPromptSubmit default scope",
		omitted: "void handleUserPromptSubmit(promptSubmit);",
		provided: "void handleUserPromptSubmit(promptSubmit, undefined, { readScope: scope });",
	},
	{
		name: "vectorSearchThroughDbOwner",
		omitted: "void vectorSearchThroughDbOwner(recallOwner, [1], { limit: 1 });",
		provided: "void vectorSearchThroughDbOwner(recallOwner, [1], { limit: 1, readScope: scope });",
	},
	{
		name: "vectorSearchThroughDbOwner default options",
		omitted: "void vectorSearchThroughDbOwner(recallOwner, [1]);",
		provided: "void vectorSearchThroughDbOwner(recallOwner, [1], { readScope: scope });",
	},
	{
		name: "applyRecallDedupeAsync",
		omitted: "void applyRecallDedupeAsync(dedupeBase);",
		provided: "void applyRecallDedupeAsync({ ...dedupeBase, readScope: scope });",
	},
	{
		name: "claimRecallItemsAsync",
		omitted: "void claimRecallItemsAsync(claimBase);",
		provided: "void claimRecallItemsAsync({ ...claimBase, readScope: scope });",
	},
];

function probeSource(variant: "omitted" | "provided"): { readonly text: string; readonly starts: number[] } {
	const lines = header.split("\n");
	const starts: number[] = [];
	for (const [index, probe] of cases.entries()) {
		starts.push(lines.length);
		lines.push(`export function probe${index}(): void {`, `\t${probe[variant]}`, "}");
	}
	return { text: lines.join("\n"), starts };
}

function diagnose(): {
	readonly header: string[];
	readonly cases: Map<string, { omitted: string[]; provided: string[] }>;
} {
	const dir = mkdtempSync(join(tmpdir(), "signet-read-scope-types-"));
	try {
		const configPath = join(SRC, "..", "tsconfig.json");
		const parsed = ts.getParsedCommandLineOfConfigFile(
			configPath,
			{},
			{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
		);
		if (!parsed) throw new Error("daemon tsconfig unreadable");
		const files = { omitted: join(dir, "omitted.ts"), provided: join(dir, "provided.ts") };
		const sources = { omitted: probeSource("omitted"), provided: probeSource("provided") };
		writeFileSync(files.omitted, sources.omitted.text);
		writeFileSync(files.provided, sources.provided.text);
		const program = ts.createProgram([files.omitted, files.provided], {
			...parsed.options,
			rootDir: undefined,
			outDir: undefined,
			noEmit: true,
		});
		const headerMessages: string[] = [];
		const result = new Map<string, { omitted: string[]; provided: string[] }>();
		for (const probe of cases) result.set(probe.name, { omitted: [], provided: [] });
		for (const variant of ["omitted", "provided"] as const) {
			const sourceFile = program.getSourceFile(files[variant]);
			if (!sourceFile) throw new Error("probe missing");
			for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
				const line =
					diagnostic.start === undefined ? -1 : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line;
				const index = sources[variant].starts.findLastIndex((start) => start <= line);
				const probe = cases[index];
				const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
				if (probe) result.get(probe.name)?.[variant].push(message);
				else headerMessages.push(message);
			}
		}
		return { header: [...new Set(headerMessages)], cases: result };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("read scope is required by the recall API types", () => {
	const outcomes = diagnose();
	it("probe imports resolve", () => {
		expect(outcomes.header).toEqual([]);
	});
	for (const probe of cases) {
		it(`${probe.name} rejects an omitted read scope and accepts an explicit one`, () => {
			const outcome = outcomes.cases.get(probe.name);
			expect(outcome?.provided).toEqual([]);
			expect(outcome?.omitted.length ?? 0).toBeGreaterThan(0);
		});
	}
});
