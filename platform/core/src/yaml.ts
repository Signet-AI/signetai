/**
 * @signet/core - YAML utilities
 */

import YAML from "yaml";

/**
 * Parse a YAML string into a JavaScript object.
 *
 * Malformed user-owned YAML should degrade to an empty object instead of
 * propagating parser exceptions into daemon or CLI startup.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	try {
		const parsed = YAML.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function isYamlRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a user-owned runtime configuration document.
 *
 * Runtime configuration is selected by filename and must fail closed when it
 * is malformed. Keep parseSimpleYaml lenient for the document and import
 * callers that intentionally treat malformed input as absent.
 */
export function parseRuntimeYaml(text: string): Record<string, unknown> {
	// Parse through a Document with logging disabled. YAML.parse() emits
	// warnings through process.emitWarning(), and its pretty warning text can
	// include the source line (including credentials) even when parsing fails
	// closed below.
	let parsed: unknown;
	try {
		const document = YAML.parseDocument(text, { logLevel: "silent", prettyErrors: false });
		if (document.errors.length > 0 || document.warnings.length > 0) {
			throw new Error("invalid YAML syntax");
		}
		parsed = document.toJS();
	} catch {
		throw new Error("invalid YAML syntax");
	}
	if (!isYamlRecord(parsed)) {
		throw new Error("top-level document must be a mapping");
	}
	return parsed;
}

/**
 * Parse a full YAML document with the bundled YAML parser.
 *
 * Use this for richer config surfaces that need arrays, deeper nesting,
 * or round-trippable values that exceed parseSimpleYaml's limits.
 */
export function parseYamlDocument(text: string): unknown {
	return YAML.parse(text);
}

/**
 * Stringify a full YAML document with the bundled YAML serializer.
 */
export function stringifyYamlDocument(value: unknown): string {
	return YAML.stringify(value);
}

/**
 * Format a JavaScript object as YAML.
 *
 * `_indent` is retained for internal call-site compatibility, but the
 * shared YAML library always emits 2-space indentation here.
 */
export function formatYaml(obj: Record<string, unknown>, _indent = 0): string {
	return YAML.stringify(obj, {
		indent: 2,
		simpleKeys: true,
	});
}
