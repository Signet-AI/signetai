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
import { isMap, isPair, parseDocument, type Document } from "yaml";
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
// docs/UPGRADING.md.
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
			if (!executor || !(executor in EXECUTOR_AGENT_MAP)) continue;
			const agent = EXECUTOR_AGENT_MAP[executor]!;
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
		note: "command executor and legacy pipelineV2.*.provider fields require manual reconfiguration (see docs/UPGRADING.md)",
	});
}

function stampConfigVersion(doc: Document.Parsed, version: number): void {
	const root = doc.contents;
	if (isMap(root)) {
		root.set("configVersion", version);
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
// v4: retire legacy pipelineV2 routing fields -> inference registry
// ---------------------------------------------------------------------------
// Compiles memory.pipelineV2.extraction/synthesis routing fields into the
// inference.accounts/targets/workloads registry (mirroring the daemon's
// compileLegacyRoutingConfig), then NULLS the legacy routing keys (provider,
// model, endpoint, fallbackProvider, command) so the registry is the single
// source of truth. Tuning fields (timeout, maxTokens, enabled) are preserved.
//
// Guarded by configVersion: 4. Idempotent: a file already at v4+ is skipped.

/** Map a legacy provider to the account name/id this migration creates. */
function legacyAccountFor(provider: string): { name: string; family: string; cred: string } | null {
	if (provider === "openrouter") return { name: "legacy-openrouter", family: "openrouter", cred: "OPENROUTER_API_KEY" };
	if (provider === "anthropic") return { name: "legacy-anthropic", family: "anthropic", cred: "ANTHROPIC_API_KEY" };
	return null; // local providers (ollama/llama-cpp/openai-compatible-local) need no account
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
	if (vMatch && Number(vMatch[1]) >= 4) return;

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		logger.warn("config-migration", "Skipping legacy-routing migration: agent.yaml has parse errors", {
			file: path,
			errors: doc.errors.map((e) => e.message).slice(0, 3),
		});
		return;
	}

	const extraction = doc.getIn(["memory", "pipelineV2", "extraction"], true);
	const synthesis = doc.getIn(["memory", "pipelineV2", "synthesis"], true);
	const hasLegacyRouting =
		(isMap(extraction) && (extraction.has("provider") || extraction.has("model") || extraction.has("endpoint"))) ||
		(isMap(synthesis) && (synthesis.has("provider") || synthesis.has("model") || synthesis.has("endpoint")));

	if (!hasLegacyRouting) {
		// Nothing to migrate; still stamp v4 so we don't re-parse every startup.
		stampConfigVersion(doc, 4);
		writeAtomic(path, doc.toString());
		return;
	}

	const mutations: string[] = [];

	// Ensure inference/accounts and inference/targets maps exist.
	const inference =
		doc.getIn(["inference"], true) ??
		doc.setIn(["inference"], doc.createNode({})) ??
		doc.getIn(["inference"], true);
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

	function compileTarget(
		source: ReturnType<typeof doc.getIn>,
		targetName: string,
		workloadKey: "memoryExtraction" | "sessionSynthesis",
	): void {
		if (!isMap(source)) return;
		const provider = String(source.get("provider", true) ?? "");
		const model = source.get("model", true);
		const endpoint = source.get("endpoint", true);
		if (!provider || provider === "none" || provider === "command") return;
		// Read `enabled` as a real boolean (defaulting to true when absent, matching
		// the runtime default). The raw YAML node's String() returns the source text
		// (e.g. "false"), which would never short-circuit and silently re-enable a
		// disabled synthesis — destructive for a migration that nulls routing keys.
		const enabled = source.get("enabled");
		if (workloadKey === "sessionSynthesis" && enabled === false) return;
		if (workloadKey === "sessionSynthesis" && provider === "acpx") return;

		// Create the account if the provider needs one.
		const acct = legacyAccountFor(provider);
		if (acct) {
			doc.setIn(["inference", "accounts", acct.name], doc.createNode({
				kind: "api",
				providerFamily: acct.family,
				credentialRef: acct.cred,
			}));
		}
		// Create/update the target.
		const targetNode = doc.createNode({
			executor: provider,
			...(acct ? { account: acct.name } : {}),
			...(endpoint ? { endpoint: String(endpoint) } : {}),
			models: { default: { model: model ? String(model) : "", reasoning: "medium" } },
		});
		doc.setIn(["inference", "targets", targetName], targetNode);
		// Bind the workload to it.
		doc.setIn(["inference", "workloads", workloadKey], doc.createNode({
			target: `${targetName}/default`,
		}));
		mutations.push(`${workloadKey} -> inference.targets.${targetName} (executor: ${provider})`);
	}

	compileTarget(extraction, "legacy-extraction", "memoryExtraction");
	compileTarget(synthesis, "legacy-synthesis", "sessionSynthesis");

	// Null the legacy ROUTING keys (keep tuning: timeout, maxTokens, enabled).
	function nullRoutingKeys(node: ReturnType<typeof doc.getIn>, label: string): void {
		if (!isMap(node)) return;
		// The command provider cannot be auto-mapped (arbitrary bin/args). Leave its
		// entire block intact so the user can manually reconfigure it.
		if (String(node.get("provider", true) ?? "") === "command") return;
		for (const key of ["provider", "model", "endpoint", "fallbackProvider", "command", "baseUrl", "base_url"]) {
			if (node.has(key)) {
				node.delete(key);
				mutations.push(`removed memory.pipelineV2.${label}.${key}`);
			}
		}
	}
	nullRoutingKeys(extraction, "extraction");
	nullRoutingKeys(synthesis, "synthesis");

	stampConfigVersion(doc, 4);
	writeAtomic(path, doc.toString());

	if (mutations.length > 0) {
		logger.info("config-migration", "Migrated legacy routing fields to inference registry", {
			mutations,
			file: path,
			note: "Routing now flows through inference.*; pipelineV2 tuning fields (timeout, maxTokens, enabled) preserved.",
		});
	}
}
