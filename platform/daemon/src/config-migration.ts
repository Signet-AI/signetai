/**
 * One-time config migration for existing agent.yaml files.
 * Flips pipeline subsystem defaults to ON (except trainingTelemetry → OFF).
 * Guarded by `configVersion: 2` to prevent re-running.
 *
 * Regex-based — matches key names anywhere in the file. The target names
 * (semanticContradictionEnabled, graphEnabled, agentFeedback, etc.) are
 * specific enough that false positives in unrelated YAML sections are
 * effectively impossible. Migration is restricted to agent.yaml/AGENT.yaml
 * (not config.yaml) to limit blast radius.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, isMap, isPair, parseDocument } from "yaml";
import { logger } from "./logger";

// Flat keys: flip false → true
const FLIP_TRUE = [
	"semanticContradictionEnabled",
	"graphEnabled",
	"rerankerEnabled",
	"autonomousEnabled",
	"allowUpdateDelete",
	"rehearsal_enabled",
	"agentFeedback",
] as const;

// Nested `enabled: false` under these parent keys → flip to true
const NESTED_PARENTS = ["graph", "reranker", "autonomous", "predictor"] as const;

function flip(text: string, key: string): string {
	return text.replace(new RegExp(`^(\\s*${key}:\\s*)false(\\s*(?:#.*)?)$`, "m"), "$1true$2");
}

// Require 2+ leading spaces so we only match inside a nested block (pipelineV2),
// not a top-level key that happens to share the same name.
// Use \r?\n to handle both LF and CRLF files.
function flipNested(text: string, parent: string): string {
	return text.replace(
		new RegExp(`(^[ ]{2,}${parent}:\\s*(?:\\r?\\n)(?:\\s+\\w+:.*(?:\\r?\\n))*?\\s+enabled:\\s*)false`, "m"),
		"$1true",
	);
}

function flipTelemetryOff(text: string): string {
	return text.replace(/^(\s*trainingTelemetry:\s*)true(\s*(?:#.*)?)$/m, "$1false$2");
}

export function migrateConfig(agentsDir: string): void {
	// Only migrate agent.yaml/AGENT.yaml — config.yaml can contain arbitrary
	// user sections where regex-based key matching would be unsafe.
	const candidates = ["agent.yaml", "AGENT.yaml"];
	let path: string | undefined;
	for (const name of candidates) {
		const p = join(agentsDir, name);
		if (existsSync(p)) {
			path = p;
			break;
		}
	}
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	// Already migrated (any version >= 2)
	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 2) return;

	const mutations: string[] = [];

	for (const key of FLIP_TRUE) {
		const before = text;
		text = flip(text, key);
		if (text !== before) mutations.push(`${key}: false → true`);
	}

	for (const parent of NESTED_PARENTS) {
		const before = text;
		text = flipNested(text, parent);
		if (text !== before) mutations.push(`${parent}.enabled: false → true`);
	}

	{
		const before = text;
		text = flipTelemetryOff(text);
		if (text !== before) mutations.push("trainingTelemetry: true → false");
	}

	// Stamp version — insert after `---` if present to keep valid YAML.
	// Handle both LF and CRLF files.
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	if (/^---(?:\r?\n|[ \t])/.test(text)) {
		const nl = text.indexOf("\n");
		text = `${text.slice(0, nl + 1)}configVersion: 2${eol}${text.slice(nl + 1)}`;
	} else {
		text = `configVersion: 2${eol}${text}`;
	}

	// Atomic write: temp file + rename to avoid partial writes on crash
	const tmp = `${path}.migration.tmp`;
	writeFileSync(tmp, text, "utf-8");
	renameSync(tmp, path);

	if (mutations.length > 0) {
		logger.info("config-migration", "Migrated config defaults", {
			mutations,
			file: path,
		});
	}
}

// ---------------------------------------------------------------------------
// v3: inference provider cutover (#947)
// ---------------------------------------------------------------------------
// Rewrites folded harness-executor targets to the retained ACPX backend.
// The folded executors (claude-code, codex, opencode) are replaced by
// `executor: acpx` with an `acpx: { agent: <mapped> }` block. The generic
// `command` executor and legacy `memory.pipelineV2.*.provider` fields cannot
// be mapped deterministically (arbitrary bin/args, or implicit-target
// compilation) and are left to the structured runtime error, which points at
// https://docs.signetai.sh/upgrading/.
//
// Guarded by `configVersion: 3`. Uses the yaml package's Document API so
// comments and formatting are preserved (regex is unsafe for block insertion).

const EXECUTOR_AGENT_MAP: Readonly<Record<string, string>> = {
	"claude-code": "claude",
	codex: "codex",
	opencode: "opencode",
};

function findConfigPath(agentsDir: string): string | undefined {
	for (const name of ["agent.yaml", "AGENT.yaml"]) {
		const p = join(agentsDir, name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

export function migrateInferenceProviders(agentsDir: string): void {
	const path = findConfigPath(agentsDir);
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	// Skip if already at v3+. (v2 may not have run on this file yet; that's
	// fine — the executor migration is independent of the default-flip migration.)
	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 3) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		// Don't migrate a file we can't parse; let config load report the error.
		logger.warn("config-migration", "Skipping inference migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((e) => e.message).slice(0, 3),
		});
		return;
	}

	const mutations: string[] = [];
	const targets = doc.getIn(["inference", "targets"], true);
	if (isMap(targets)) {
		for (const pair of targets.items) {
			if (!isPair(pair)) continue;
			const targetName = String(pair.key);
			const target = pair.value;
			if (!isMap(target)) continue;
			const execNode = target.get("executor", true);
			const executor = execNode ? String(execNode) : undefined;
			if (!executor) continue;
			const agent = EXECUTOR_AGENT_MAP[executor];
			if (!agent) continue;
			// Only insert an acpx block if one isn't already present (avoid duplicates).
			if (!target.has("acpx")) {
				target.set("acpx", doc.createNode({ agent }));
			}
			target.set("executor", "acpx");
			mutations.push(`inference.targets.${targetName}.executor: ${executor} → acpx (agent: ${agent})`);
		}
	}

	if (mutations.length === 0) {
		// Still stamp v3 so we don't re-parse on every startup.
		stampConfigVersion(doc, 3);
		writeAtomic(path, doc.toString());
		return;
	}

	stampConfigVersion(doc, 3);
	writeAtomic(path, doc.toString());

	logger.info("config-migration", "Migrated folded inference executors to acpx", {
		mutations,
		file: path,
		note: "command executor and legacy pipelineV2.*.provider fields require manual reconfiguration (see https://docs.signetai.sh/upgrading/)",
	});
}

function stampConfigVersion(doc: Document.Parsed, version: number): void {
	// Use Document.set (typed `key: any, value: unknown`) rather than the
	// narrowed YAMLMap.set on `doc.contents`, which types its key as ParsedNode
	// and rejects the string key "configVersion" (TS2345). Document.set
	// delegates to contents.set when contents is a map, so behavior is
	// identical for both branches.
	const root = doc.contents;
	if (isMap(root)) {
		doc.set("configVersion", version);
	} else {
		// Empty or non-map document — wrap it.
		doc.set("configVersion", version);
	}
}

function writeAtomic(path: string, contents: string): void {
	const tmp = `${path}.migration.tmp`;
	writeFileSync(tmp, contents, "utf-8");
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// v4/v5: retire legacy pipelineV2 routing fields -> inference registry
// ---------------------------------------------------------------------------
// Compiles memory.pipelineV2.extraction/synthesis routing fields into the
// inference.accounts/targets/workloads registry, then NULLS the legacy routing keys (provider,
// model, endpoint, fallbackProvider, command) so the registry is the single
// source of truth. Tuning fields (timeout, maxTokens, enabled) are preserved.
//
// v5 completes the v4 cleanup by removing legacy flat routing keys. It must
// rerun for v4 configs because the incomplete migration shipped to users.
// Idempotent: a file already at v5+ is skipped.

const LEGACY_FLAT_KEYS = [
	"extractionProvider",
	"extractionModel",
	"extractionEndpoint",
	"extractionBaseUrl",
	"extractionFallbackProvider",
	"extractionStrength",
] as const;

const LEGACY_FLAT_ROUTING_KEYS = [
	"extractionProvider",
	"extractionModel",
	"extractionEndpoint",
	"extractionBaseUrl",
	"extractionFallbackProvider",
] as const;

const LEGACY_HARNESS_AGENT: Readonly<Record<string, string>> = {
	"claude-code": "claude",
	codex: "codex",
	opencode: "opencode",
};

/** Map a legacy provider to the account name/id this migration creates. */
function legacyAccountFor(provider: string): { name: string; family: string; cred: string } | null {
	if (provider === "openrouter") return { name: "legacy-openrouter", family: "openrouter", cred: "OPENROUTER_API_KEY" };
	if (provider === "anthropic") return { name: "legacy-anthropic", family: "anthropic", cred: "ANTHROPIC_API_KEY" };
	return null; // local providers (ollama/llama-cpp/openai-compatible-local) need no account
}

function legacyExecutorFor(provider: string): { executor: string; acpxAgent?: string } | null {
	const acpxAgent = LEGACY_HARNESS_AGENT[provider];
	if (acpxAgent) return { executor: "acpx", acpxAgent };
	if (["acpx", "anthropic", "openrouter", "ollama", "llama-cpp", "openai-compatible"].includes(provider)) {
		return { executor: provider };
	}
	return null;
}

export function migrateLegacyRoutingToRegistry(agentsDir: string): void {
	const path = findConfigPath(agentsDir);
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 5) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		logger.warn("config-migration", "Skipping legacy-routing migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((e) => e.message).slice(0, 3),
		});
		return;
	}

	const pipeline = doc.getIn(["memory", "pipelineV2"], true);
	const extraction = doc.getIn(["memory", "pipelineV2", "extraction"], true);
	const synthesis = doc.getIn(["memory", "pipelineV2", "synthesis"], true);
	const hasLegacyFlatKeys = isMap(pipeline) && LEGACY_FLAT_KEYS.some((key) => pipeline.has(key));
	const hasLegacyFlatRouting = isMap(pipeline) && LEGACY_FLAT_ROUTING_KEYS.some((key) => pipeline.has(key));
	const hasSynthesisBlock = isMap(pipeline) && pipeline.has("synthesis");
	const hasNestedLegacyRouting =
		(isMap(extraction) &&
			["provider", "model", "endpoint", "baseUrl", "base_url"].some((key) => extraction.has(key))) ||
		(isMap(synthesis) && ["provider", "model", "endpoint", "baseUrl", "base_url"].some((key) => synthesis.has(key)));

	if (!hasNestedLegacyRouting && !hasLegacyFlatKeys && !hasSynthesisBlock) {
		// Nothing to migrate; still stamp v5 so we don't re-parse every startup.
		stampConfigVersion(doc, 5);
		writeAtomic(path, doc.toString());
		return;
	}

	const mutations: string[] = [];

	if (hasSynthesisBlock && isMap(pipeline)) {
		pipeline.delete("synthesis");
		mutations.push("removed memory.pipelineV2.synthesis");
	}

	if (hasNestedLegacyRouting || hasLegacyFlatRouting) {
		// Ensure inference/accounts and inference/targets maps exist.
		const inference =
			doc.getIn(["inference"], true) ?? doc.setIn(["inference"], doc.createNode({})) ?? doc.getIn(["inference"], true);
		if (!isMap(inference)) {
			doc.setIn(["inference"], doc.createNode({}));
		}
		if (!doc.getIn(["inference", "targets"], true)) {
			doc.setIn(["inference", "targets"], doc.createNode({}));
		}
		if (!doc.getIn(["inference", "accounts"], true)) {
			doc.setIn(["inference", "accounts"], doc.createNode({}));
		}
		if (!doc.getIn(["inference", "workloads"], true)) {
			doc.setIn(["inference", "workloads"], doc.createNode({}));
		}
	}

	const existingWorkloads = doc.getIn(["inference", "workloads"], true);
	const existingTargets = doc.getIn(["inference", "targets"], true);
	const existingExtractionBinding = isMap(existingWorkloads)
		? existingWorkloads.get("memoryExtraction", true)
		: undefined;
	const canonicalTargetRef = isMap(existingExtractionBinding)
		? String(existingExtractionBinding.get("target", true) ?? "")
		: "";
	const canonicalTargetName = canonicalTargetRef.split("/", 1)[0] ?? "";
	const hasCanonicalExtractionRoute =
		isMap(existingTargets) && canonicalTargetName !== "" && existingTargets.has(canonicalTargetName);

	function compileTarget(
		providerValue: unknown,
		modelValue: unknown,
		endpointValue: unknown,
		targetName: string,
	): boolean {
		const rawProvider = String(providerValue ?? "").trim();
		const provider = rawProvider || (modelValue != null || endpointValue != null ? "llama-cpp" : "");
		if (!provider || provider === "none") return false;
		const executor = legacyExecutorFor(provider);
		if (!executor) {
			logger.warn("config-migration", "Legacy inference provider requires manual reconfiguration", {
				provider,
				target: targetName,
				file: path,
				note: "The legacy routing fields were preserved; configure an inference.targets entry.",
			});
			return false;
		}

		const model = String(modelValue ?? "");
		const endpoint = String(endpointValue ?? "");
		const acct = legacyAccountFor(provider);
		if (acct) {
			doc.setIn(
				["inference", "accounts", acct.name],
				doc.createNode({
					kind: "api",
					providerFamily: acct.family,
					credentialRef: acct.cred,
				}),
			);
		}
		const targetNode = doc.createNode({
			executor: executor.executor,
			...(executor.acpxAgent ? { acpx: { agent: executor.acpxAgent } } : {}),
			...(acct ? { account: acct.name } : {}),
			...(endpoint ? { endpoint } : {}),
			models: { default: { model, reasoning: "medium" } },
		});
		doc.setIn(["inference", "targets", targetName], targetNode);
		doc.setIn(
			["inference", "workloads", "memoryExtraction"],
			doc.createNode({
				target: `${targetName}/default`,
			}),
		);
		mutations.push(`memoryExtraction -> inference.targets.${targetName} (executor: ${executor.executor})`);
		return true;
	}

	const flatProvider = isMap(pipeline) ? pipeline.get("extractionProvider", true) : undefined;
	const flatModel = isMap(pipeline) ? pipeline.get("extractionModel", true) : undefined;
	const flatEndpoint = isMap(pipeline)
		? (pipeline.get("extractionEndpoint", true) ?? pipeline.get("extractionBaseUrl", true))
		: undefined;
	const flatProviderText = String(flatProvider ?? "").trim();
	let compiledFlat = false;
	if (hasLegacyFlatRouting && !hasCanonicalExtractionRoute) {
		compiledFlat = compileTarget(flatProvider, flatModel, flatEndpoint, "legacy-extraction");
	}
	if (
		!hasCanonicalExtractionRoute &&
		(!hasLegacyFlatRouting || (!compiledFlat && flatProviderText !== "none")) &&
		hasNestedLegacyRouting &&
		isMap(extraction)
	) {
		compileTarget(
			extraction.get("provider", true),
			extraction.get("model", true),
			extraction.get("endpoint", true) ?? extraction.get("baseUrl", true) ?? extraction.get("base_url", true),
			"legacy-extraction",
		);
	}

	// Remove legacy extraction routing keys; the obsolete synthesis block is deleted.
	function nullRoutingKeys(node: ReturnType<typeof doc.getIn>, label: string): void {
		if (!isMap(node)) return;
		const provider = String(node.get("provider", true) ?? "").trim();
		// Preserve unmappable providers so the runtime can report an actionable
		// configuration error instead of silently deleting the user's route.
		if (provider && provider !== "none" && !legacyExecutorFor(provider)) return;
		for (const key of ["provider", "model", "endpoint", "fallbackProvider", "command", "baseUrl", "base_url"]) {
			if (node.has(key)) {
				node.delete(key);
				mutations.push(`removed memory.pipelineV2.${label}.${key}`);
			}
		}
	}
	nullRoutingKeys(extraction, "extraction");

	if (isMap(pipeline)) {
		const flatStrength = pipeline.get("extractionStrength");
		if (flatStrength !== undefined && flatStrength !== null) {
			const canonicalExtraction = isMap(extraction) ? extraction : doc.createNode({ strength: flatStrength });
			if (!isMap(extraction)) {
				pipeline.set("extraction", canonicalExtraction);
			} else {
				canonicalExtraction.set("strength", flatStrength);
			}
			mutations.push("moved memory.pipelineV2.extractionStrength -> extraction.strength");
		}
		const flatProviderText = String(pipeline.get("extractionProvider", true) ?? "").trim();
		const canRemoveFlatRouting =
			!flatProviderText ||
			flatProviderText === "none" ||
			legacyExecutorFor(flatProviderText) !== null ||
			hasCanonicalExtractionRoute;
		for (const key of LEGACY_FLAT_KEYS) {
			if (!pipeline.has(key)) continue;
			if (key !== "extractionStrength" && !canRemoveFlatRouting) continue;
			pipeline.delete(key);
			mutations.push(`removed memory.pipelineV2.${key}`);
		}
	}

	stampConfigVersion(doc, 5);
	writeAtomic(path, doc.toString());

	if (mutations.length > 0) {
		logger.info("config-migration", "Migrated legacy routing fields to inference registry", {
			mutations,
			file: path,
			note: "Routing now flows through inference.*; extraction tuning fields remain.",
		});
	}
}

// ---------------------------------------------------------------------------
// v6: remove the obsolete session-synthesis inference route
// ---------------------------------------------------------------------------
// Session processing is internal and follows memoryExtraction/default routing.
// Older migrations created workloads.sessionSynthesis -> legacy-synthesis/default,
// which permanently preserved an unavailable local target after upgrades.
export function migrateSessionSynthesisRoute(agentsDir: string): void {
	const path = findConfigPath(agentsDir);
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 6) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		logger.warn("config-migration", "Skipping session-route migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((error) => error.message).slice(0, 3),
		});
		return;
	}

	const mutations: string[] = [];
	const workloads = doc.getIn(["inference", "workloads"], true);
	if (isMap(workloads) && workloads.has("sessionSynthesis")) {
		workloads.delete("sessionSynthesis");
		mutations.push("removed inference.workloads.sessionSynthesis");
	}
	const targets = doc.getIn(["inference", "targets"], true);
	if (isMap(targets) && targets.has("legacy-synthesis")) {
		targets.delete("legacy-synthesis");
		mutations.push("removed inference.targets.legacy-synthesis");
	}
	const taskClasses = doc.getIn(["inference", "taskClasses"], true);
	if (isMap(taskClasses) && taskClasses.has("session_synthesis")) {
		taskClasses.delete("session_synthesis");
		mutations.push("removed inference.taskClasses.session_synthesis");
	}

	stampConfigVersion(doc, 6);
	writeAtomic(path, doc.toString());
	if (mutations.length > 0) {
		logger.info("config-migration", "Removed obsolete session synthesis route", { mutations, file: path });
	}
}

// ---------------------------------------------------------------------------
// v7: remove retired extraction-worker write gate settings
// ---------------------------------------------------------------------------
// The write gate and durability settings belonged exclusively to the retired
// extraction worker. Remove them before config validation so existing agent
// files reach the canonical Dreaming-only configuration without a startup
// failure. This is intentionally a one-time rewrite, not a runtime fallback.
const RETIRED_EXTRACTION_WRITER_KEYS = [
	"writeGate",
	"durability",
	"writeGateEnabled",
	"writeGateThreshold",
	"writeGateContinuityDiscount",
] as const;

export function migrateRetiredExtractionWriterConfig(agentsDir: string): void {
	const path = findConfigPath(agentsDir);
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 7) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		logger.warn("config-migration", "Skipping retired writer config migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((error) => error.message).slice(0, 3),
		});
		return;
	}

	const pipeline = doc.getIn(["memory", "pipelineV2"], true);
	const mutations: string[] = [];
	if (isMap(pipeline)) {
		for (const key of RETIRED_EXTRACTION_WRITER_KEYS) {
			if (!pipeline.has(key)) continue;
			pipeline.delete(key);
			mutations.push(`removed memory.pipelineV2.${key}`);
		}
	}

	stampConfigVersion(doc, 7);
	writeAtomic(path, doc.toString());
	if (mutations.length > 0) {
		logger.info("config-migration", "Removed retired extraction writer configuration", { mutations, file: path });
	}
}

// ---------------------------------------------------------------------------
// v8: canonicalize embedding endpoints and remove retired memory-pipeline routing
// ---------------------------------------------------------------------------
// The dashboard briefly wrote `baseUrl`, while the daemon's canonical embedding
// schema uses `base_url`. v5-v7 configs may also contain retired memory-pipeline
// routing keys. Apply both changes in one v8 migration so neither operation can
// stamp version 8 before the other has run.
const RETIRED_MEMORY_ROUTING_KEYS = [
	"allowRemoteProviders",
	"extractionProvider",
	"extractionModel",
	"extractionEndpoint",
	"extractionBaseUrl",
	"extractionFallbackProvider",
	"extractionCommand",
] as const;

function migrateV8(agentsDir: string): void {
	const path = findConfigPath(agentsDir);
	if (!path) return;

	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return;
	}

	const vMatch = /^configVersion:\s*(\d+)/m.exec(text);
	if (vMatch && Number(vMatch[1]) >= 8) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		logger.warn("config-migration", "Skipping v8 config migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((error) => error.message).slice(0, 3),
		});
		return;
	}

	const mutations: string[] = [];
	for (const pathParts of [["embedding"], ["memory", "embeddings"]] as const) {
		const block = doc.getIn(pathParts, true);
		if (!isMap(block) || !block.has("baseUrl")) continue;

		const alias = block.get("baseUrl", true);
		if (!block.has("base_url")) {
			block.set("base_url", alias);
			mutations.push(`${pathParts.join(".")}.baseUrl → base_url`);
		} else if (String(block.get("base_url")) !== String(alias)) {
			logger.warn("config-migration", "Embedding config contains conflicting endpoint keys; keeping base_url", {
				file: path,
				path: pathParts.join("."),
			});
		}
		block.delete("baseUrl");
		block.delete("endpoint");
	}

	const memory = doc.getIn(["memory"], true);
	if (isMap(memory) && memory.has("synthesis")) {
		memory.delete("synthesis");
		mutations.push("removed memory.synthesis");
	}

	const pipeline = doc.getIn(["memory", "pipelineV2"], true);
	if (isMap(pipeline)) {
		if (pipeline.has("synthesis")) {
			pipeline.delete("synthesis");
			mutations.push("removed memory.pipelineV2.synthesis");
		}
		const flatProvider = String(pipeline.get("extractionProvider", true) ?? "").trim();
		const preserveFlatRouting =
			flatProvider !== "" && flatProvider !== "none" && legacyExecutorFor(flatProvider) === null;
		for (const key of RETIRED_MEMORY_ROUTING_KEYS) {
			if (!pipeline.has(key)) continue;
			if (preserveFlatRouting && key !== "allowRemoteProviders") continue;
			pipeline.delete(key);
			mutations.push(`removed memory.pipelineV2.${key}`);
		}
		const extraction = pipeline.get("extraction", true);
		if (isMap(extraction)) {
			const nestedProvider = String(extraction.get("provider", true) ?? "").trim();
			const preserveNestedRouting =
				nestedProvider !== "" && nestedProvider !== "none" && legacyExecutorFor(nestedProvider) === null;
			for (const key of [
				"provider",
				"model",
				"endpoint",
				"baseUrl",
				"base_url",
				"fallbackProvider",
				"allowRemoteProviders",
				"command",
			]) {
				if (!extraction.has(key)) continue;
				if (preserveNestedRouting && key !== "allowRemoteProviders") continue;
				extraction.delete(key);
				mutations.push(`removed memory.pipelineV2.extraction.${key}`);
			}
		}
	}

	stampConfigVersion(doc, 8);
	writeAtomic(path, doc.toString());
	if (mutations.length > 0) {
		logger.info("config-migration", "Applied v8 config migration", { mutations, file: path });
	}
}

export function migrateEmbeddingBaseUrl(agentsDir: string): void {
	migrateV8(agentsDir);
}

export function migrateRetiredMemoryPipelineRouting(agentsDir: string): void {
	migrateV8(agentsDir);
}
