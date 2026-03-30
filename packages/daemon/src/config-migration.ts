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
