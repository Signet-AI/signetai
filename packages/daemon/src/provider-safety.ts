import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type PipelineProviderChoice, isPipelineProvider } from "@signet/core";
import { parse, stringify } from "yaml";
import { logger } from "./logger.js";

export class RollbackError extends Error {
	constructor(
		message: string,
		readonly status: 404 | 400 | 409,
	) {
		super(message);
		this.name = "RollbackError";
	}
}

export type ProviderSafetyRole = "extraction" | "synthesis";

export function parseProviderSafetyRole(
	value: unknown,
): { ok: true; role?: ProviderSafetyRole } | { ok: false; error: string } {
	if (value === undefined) return { ok: true };
	if (value === "extraction" || value === "synthesis") return { ok: true, role: value };
	return { ok: false, error: "role must be 'extraction' or 'synthesis'" };
}

export interface ProviderTransitionAuditEntry {
	readonly role: ProviderSafetyRole;
	readonly from: string | null;
	readonly to: string;
	readonly timestamp: string;
	readonly source: string;
	readonly actor?: string;
	readonly risky: boolean;
	readonly rolledBack?: boolean;
}

export interface ProviderSafetySnapshot {
	readonly extractionProvider?: string;
	readonly synthesisProvider?: string;
	readonly allowRemoteProviders: boolean;
	readonly allowRemoteProvidersExplicit: boolean;
}

const REMOTE_PROVIDERS = new Set(["claude-code", "codex", "opencode", "anthropic", "openrouter", "command"]);
const LOCAL_PROVIDERS = new Set(["none", "llama-cpp", "ollama"]);
const AUDIT_FILE = ".daemon/provider-transitions.json";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readProvider(value: unknown): PipelineProviderChoice | undefined {
	return isPipelineProvider(value) ? value : undefined;
}

export function tryReadProviderSafetySnapshot(content: string): ProviderSafetySnapshot | undefined {
	try {
		return readProviderSafetySnapshot(content);
	} catch {
		return undefined;
	}
}

export function isRemotePipelineProvider(provider: string | undefined | null): boolean {
	return provider !== undefined && provider !== null && REMOTE_PROVIDERS.has(provider);
}

export function providerFallbackForLock(
	provider: PipelineProviderChoice,
	fallback: "llama-cpp" | "ollama" | "none" | undefined,
): PipelineProviderChoice {
	return isRemotePipelineProvider(provider) ? (fallback ?? "none") : provider;
}

export function readProviderSafetySnapshot(content: string): ProviderSafetySnapshot {
	const root = asRecord(parse(content)) ?? {};
	const memory = asRecord(root.memory);
	const pipeline = asRecord(memory?.pipelineV2);
	const extraction = asRecord(pipeline?.extraction);
	const synthesis = asRecord(pipeline?.synthesis);
	const flatExtraction = readProvider(pipeline?.extractionProvider);
	const nestedExtraction = readProvider(extraction?.provider);
	const synthesisProvider = readProvider(synthesis?.provider);
	const explicitAllowRemote =
		typeof pipeline?.allowRemoteProviders === "boolean" || typeof extraction?.allowRemoteProviders === "boolean";
	const topLevelRemote =
		typeof pipeline?.allowRemoteProviders === "boolean" ? pipeline?.allowRemoteProviders : undefined;
	const extractionRemote =
		typeof extraction?.allowRemoteProviders === "boolean" ? extraction?.allowRemoteProviders : undefined;
	if (topLevelRemote !== undefined && extractionRemote !== undefined && topLevelRemote !== extractionRemote) {
		logger.warn(
			"provider-safety",
			"pipelineV2.allowRemoteProviders and extraction.allowRemoteProviders conflict; top-level takes precedence",
			{ topLevel: topLevelRemote, extraction: extractionRemote },
		);
	}
	const allowRemoteProviders = topLevelRemote ?? extractionRemote ?? true;
	return {
		extractionProvider: flatExtraction ?? nestedExtraction,
		synthesisProvider,
		allowRemoteProviders,
		allowRemoteProvidersExplicit: explicitAllowRemote,
	};
}

export function validateProviderSafety(content: string): { ok: true } | { ok: false; error: string } {
	const snapshot = tryReadProviderSafetySnapshot(content);
	if (!snapshot) return { ok: false, error: "Invalid YAML config" };
	if (snapshot.allowRemoteProviders) return { ok: true };
	const blocked = [
		["extraction", snapshot.extractionProvider],
		["synthesis", snapshot.synthesisProvider],
	].filter(([, provider]) => isRemotePipelineProvider(provider));
	if (blocked.length === 0) return { ok: true };
	const parts = blocked.map(([role, provider]) => `${role} provider '${provider}'`);
	return {
		ok: false,
		error: `memory.pipelineV2.allowRemoteProviders is false; refusing: ${parts.join(", ")}. Set allowRemoteProviders: true before enabling paid or remote providers.`,
	};
}

export function preserveLockInYaml(content: string): string {
	const doc = asRecord(parse(content)) ?? {};
	const memory = asRecord(doc.memory);
	if (!memory) return content;
	const pipeline = asRecord(memory.pipelineV2);
	if (!pipeline) return content;
	if (pipeline.allowRemoteProviders !== false) {
		pipeline.allowRemoteProviders = false;
	}
	memory.pipelineV2 = pipeline;
	doc.memory = memory;
	return stringify(doc);
}

export function detectProviderTransitions(
	beforeContent: string | undefined,
	afterContent: string,
	source: string,
	actor?: string,
	now = new Date(),
): ProviderTransitionAuditEntry[] {
	const before = beforeContent === undefined ? undefined : tryReadProviderSafetySnapshot(beforeContent);
	const after = tryReadProviderSafetySnapshot(afterContent);
	if (!after) return [];
	const timestamp = now.toISOString();
	const entries: ProviderTransitionAuditEntry[] = [];
	const pairs: Array<[ProviderSafetyRole, string | undefined, string | undefined]> = [
		["extraction", before?.extractionProvider, after.extractionProvider],
		["synthesis", before?.synthesisProvider, after.synthesisProvider],
	];
	for (const [role, from, to] of pairs) {
		if (!to || from === to) continue;
		entries.push({
			role,
			from: from ?? null,
			to,
			timestamp,
			source,
			actor,
			risky: (from === undefined || LOCAL_PROVIDERS.has(from)) && isRemotePipelineProvider(to),
		});
	}
	return entries;
}

export function providerAuditPath(agentsDir: string): string {
	return join(agentsDir, AUDIT_FILE);
}

function isValidTransitionEntry(raw: unknown): raw is ProviderTransitionAuditEntry {
	if (typeof raw !== "object" || raw === null) return false;
	const rec = raw as Record<string, unknown>;
	return (
		typeof rec.role === "string" &&
		(rec.role === "extraction" || rec.role === "synthesis") &&
		typeof rec.to === "string" &&
		isPipelineProvider(rec.to) &&
		(rec.from === null || (typeof rec.from === "string" && isPipelineProvider(rec.from))) &&
		typeof rec.timestamp === "string" &&
		rec.timestamp.length > 0 &&
		typeof rec.source === "string" &&
		rec.source.length > 0 &&
		typeof rec.risky === "boolean" &&
		(rec.rolledBack === undefined || typeof rec.rolledBack === "boolean") &&
		(rec.actor === undefined || typeof rec.actor === "string")
	);
}

export function readProviderTransitions(agentsDir: string): ProviderTransitionAuditEntry[] {
	const path = providerAuditPath(agentsDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidTransitionEntry) as ProviderTransitionAuditEntry[];
	} catch (e) {
		const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
		if (code === "ENOENT") return [];
		logger.error("provider-safety", "Failed to read audit file", e instanceof Error ? e : undefined, {
			path,
			...(e instanceof Error ? {} : { error: String(e) }),
		});
		return [];
	}
}

function atomicWrite(targetPath: string, content: string, prefix = ".atomic-"): void {
	const tmpPath = join(dirname(targetPath), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, targetPath);
	} catch (e) {
		try {
			unlinkSync(tmpPath);
		} catch {}
		throw e;
	}
}

const auditMutationQueues = new Map<string, Promise<void>>();

async function enqueueProviderAuditMutation<T>(
	agentsDir: string,
	mutation: (auditPath: string) => T | Promise<T>,
): Promise<T> {
	const path = providerAuditPath(agentsDir);
	const previous = auditMutationQueues.get(path) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(() => mutation(path));
	const queued = next
		.then(
			() => undefined,
			() => undefined,
		)
		.finally(() => {
			if (auditMutationQueues.get(path) === queued) auditMutationQueues.delete(path);
		});
	auditMutationQueues.set(path, queued);
	return next;
}

function appendProviderTransitionsUnlocked(
	agentsDir: string,
	entries: readonly ProviderTransitionAuditEntry[],
	auditPath: string,
): void {
	if (entries.length === 0) return;
	mkdirSync(dirname(auditPath), { recursive: true });
	const existing = readProviderTransitions(agentsDir);
	const next = [...existing, ...entries].slice(-100);
	if (next.length < existing.length + entries.length) {
		logger.warn("provider-safety", "Audit log truncated to 100 entries; oldest transitions dropped", {
			dropped: existing.length + entries.length - next.length,
			total: next.length,
		});
	}
	atomicWrite(auditPath, `${JSON.stringify(next, null, 2)}\n`, ".audit-");
}

export async function appendProviderTransitions(
	agentsDir: string,
	entries: readonly ProviderTransitionAuditEntry[],
): Promise<void> {
	if (entries.length === 0) return;
	return enqueueProviderAuditMutation(agentsDir, (path) => appendProviderTransitionsUnlocked(agentsDir, entries, path));
}

export const CONFIG_FILE_CANDIDATES = ["agent.yaml", "AGENT.yaml", "config.yaml"] as const;

function isRollbackEligible(candidate: ProviderTransitionAuditEntry, requestedRole?: ProviderSafetyRole): boolean {
	return (
		!!candidate.from &&
		!candidate.rolledBack &&
		candidate.source !== "api/config/provider-safety/rollback" &&
		(!requestedRole || candidate.role === requestedRole)
	);
}

function markRolledBack(target: ProviderTransitionAuditEntry): ProviderTransitionAuditEntry {
	return {
		role: target.role,
		from: target.from,
		to: target.to,
		timestamp: target.timestamp,
		source: target.source,
		actor: target.actor,
		risky: target.risky,
		rolledBack: true,
	};
}

function isSameTransition(left: ProviderTransitionAuditEntry, right: ProviderTransitionAuditEntry): boolean {
	return (
		left.role === right.role &&
		left.from === right.from &&
		left.to === right.to &&
		left.timestamp === right.timestamp &&
		left.source === right.source
	);
}

function consumeProviderTransitionUnlocked(
	agentsDir: string,
	target: ProviderTransitionAuditEntry,
	rollbackEntries: readonly ProviderTransitionAuditEntry[],
	auditPath: string,
): void {
	mkdirSync(dirname(auditPath), { recursive: true });
	const existing = readProviderTransitions(agentsDir);
	const next = [...existing];
	const targetIndex = next.findIndex((entry) => isSameTransition(entry, target));
	if (targetIndex >= 0) {
		next[targetIndex] = markRolledBack(next[targetIndex]);
	} else {
		logger.warn("provider-safety", "Rollback audit target missing during consume; preserving consumed marker", {
			role: target.role,
			source: target.source,
			timestamp: target.timestamp,
		});
		next.push(markRolledBack(target));
	}
	const merged = [...next, ...rollbackEntries].slice(-100);
	atomicWrite(auditPath, `${JSON.stringify(merged, null, 2)}\n`, ".audit-");
}

async function consumeProviderTransition(
	agentsDir: string,
	target: ProviderTransitionAuditEntry,
	rollbackEntries: readonly ProviderTransitionAuditEntry[],
): Promise<void> {
	return enqueueProviderAuditMutation(agentsDir, (auditPath) =>
		consumeProviderTransitionUnlocked(agentsDir, target, rollbackEntries, auditPath),
	);
}

export function resolveRollbackFilePath(
	agentsDir: string,
	requestedRole?: ProviderSafetyRole,
): { filePath: string; transitions: ProviderTransitionAuditEntry[] } {
	const transitions = readProviderTransitions(agentsDir);
	const reversed = [...transitions].reverse();
	const match = reversed.find((c) => isRollbackEligible(c, requestedRole));
	if (match) {
		const fromSource = CONFIG_FILE_CANDIDATES.find((c) => match.source.toLowerCase().endsWith(c.toLowerCase()));
		if (fromSource) {
			const actualName = match.source.slice(-fromSource.length);
			const resolved = join(agentsDir, actualName);
			if (existsSync(resolved)) return { filePath: resolved, transitions };
			throw new RollbackError(
				`Source config file '${actualName}' not found; it may have been renamed or deleted since the transition was recorded`,
				404,
			);
		}
		throw new RollbackError(
			`Transition source '${match.source}' does not match any known config file; cannot determine which file to roll back`,
			404,
		);
	}
	const fallback = CONFIG_FILE_CANDIDATES.find((name) => existsSync(join(agentsDir, name))) ?? "agent.yaml";
	return { filePath: join(agentsDir, fallback), transitions };
}

export async function executeProviderRollback(
	agentsDir: string,
	filePath: string,
	requestedRole?: ProviderSafetyRole,
	actor?: string,
	priorTransitions?: ProviderTransitionAuditEntry[],
): Promise<{
	success: true;
	file: string;
	rolledBack: ProviderTransitionAuditEntry;
	providerTransitions: ProviderTransitionAuditEntry[];
	isRetry: boolean;
}> {
	const transitions = [...(priorTransitions ?? readProviderTransitions(agentsDir))];
	const reversed = [...transitions].reverse();
	const matchIdx = reversed.findIndex((c) => isRollbackEligible(c, requestedRole));
	if (matchIdx < 0) throw new RollbackError("No provider transition with rollback target found", 404);
	const entry = reversed[matchIdx];
	if (!existsSync(filePath)) {
		throw new RollbackError(`Config file '${basename(filePath)}' not found`, 404);
	}

	const beforeContent = readFileSync(filePath, "utf-8");
	const nextContent = applyProviderRollback(beforeContent, entry);
	const beforeRoot = asRecord(parse(beforeContent)) ?? {};
	const nextRoot = asRecord(parse(nextContent)) ?? {};
	const isNoOp = JSON.stringify(beforeRoot) === JSON.stringify(nextRoot);
	if (isNoOp) {
		const previous = readString(entry.from);
		const memory = asRecord(beforeRoot.memory);
		const pipeline = memory ? asRecord(memory.pipelineV2) : undefined;
		const roleKey = entry.role === "extraction" ? "extraction" : "synthesis";
		const roleBlock = pipeline ? asRecord(pipeline[roleKey]) : undefined;
		const rawTopLevel = entry.role === "extraction" && pipeline ? pipeline.extractionProvider : undefined;
		const rawNested = roleBlock?.provider;
		const topLevelProvider = typeof rawTopLevel === "string" && rawTopLevel.length > 0 ? rawTopLevel : null;
		const blockProvider = typeof rawNested === "string" && rawNested.length > 0 ? rawNested : null;
		const currentProvider = topLevelProvider ?? blockProvider;
		if (currentProvider !== previous) {
			throw new RollbackError(
				currentProvider === null
					? `No ${entry.role} configuration found to roll back`
					: `Rollback target provider "${previous ?? ""}" does not match current "${currentProvider}"`,
				400,
			);
		}
		await consumeProviderTransition(agentsDir, entry, []);
		return {
			success: true,
			file: basename(filePath),
			rolledBack: markRolledBack(entry),
			providerTransitions: [],
			isRetry: true,
		};
	}
	const safety = validateProviderSafety(nextContent);
	if (!safety.ok) throw new RollbackError(safety.error, 400);

	const rollbackEntries = detectProviderTransitions(
		beforeContent,
		nextContent,
		"api/config/provider-safety/rollback",
		actor,
	);
	// Config-first: if audit write fails after config, the entry is
	// unconsumed. On retry, applyProviderRollback clears stale fields
	// idempotently and JSON.stringify comparison detects no semantic
	// change, so the no-op guard marks the entry consumed without
	// rewriting the config.
	atomicWrite(filePath, nextContent, ".rollback-");
	try {
		await consumeProviderTransition(agentsDir, entry, rollbackEntries);
	} catch (e) {
		// Config is correct but audit is stale; retry will hit the
		// semantic no-op guard above and mark the entry consumed audit-only.
		logger.error("provider-safety", "Audit write failed after config rollback", e instanceof Error ? e : undefined, {
			...(e instanceof Error ? {} : { error: String(e) }),
		});
	}
	return {
		success: true,
		file: basename(filePath),
		rolledBack: markRolledBack(entry),
		providerTransitions: rollbackEntries,
		isRetry: rollbackEntries.length === 0,
	};
}

export function applyProviderRollback(content: string, entry: ProviderTransitionAuditEntry): string {
	const previous = readString(entry.from);
	if (!previous) throw new RollbackError("No previous provider recorded for rollback", 400);
	const root = asRecord(parse(content)) ?? {};
	const memory = asRecord(root.memory);
	const pipeline = memory ? asRecord(memory.pipelineV2) : undefined;
	if (!pipeline) throw new RollbackError("No pipelineV2 section found in config", 400);
	const roleKey = entry.role === "extraction" ? "extraction" : "synthesis";
	const roleBlock = asRecord(pipeline[roleKey]);
	if (entry.role === "extraction") {
		pipeline.extractionProvider = previous;
		if (roleBlock) {
			roleBlock.provider = previous;
			roleBlock.model = undefined;
			roleBlock.endpoint = undefined;
			roleBlock.base_url = undefined;
		}
		pipeline.extractionModel = undefined;
		pipeline.extractionEndpoint = undefined;
		pipeline.extractionBaseUrl = undefined;
	} else {
		if (roleBlock) {
			roleBlock.provider = previous;
			roleBlock.model = undefined;
			roleBlock.endpoint = undefined;
			roleBlock.base_url = undefined;
		}
	}
	return stringify(root);
}
