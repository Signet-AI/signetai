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
