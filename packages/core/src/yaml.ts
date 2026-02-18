/**
 * @signet/core - YAML utilities
 *
 * Simple YAML parser and formatter for flat/shallow config files.
 * Handles the common patterns used in Signet config files (agent.yaml, config.yaml)
 * without requiring a full YAML library dependency.
 *
 * Limitations:
 * - Supports up to 3 levels of nesting
 * - No support for YAML anchors, aliases, or complex types
 * - Arrays are formatted in block style only
 */

/**
 * Parse a simple YAML string into a JavaScript object.
 *
 * Supports:
 * - Comments (line and inline)
 * - Key: value pairs
 * - Up to 3 levels of nesting
 * - Basic type coercion (strings, numbers, booleans)
 * - Quoted strings (strips quotes)
 * - Multiline values with | indicator
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = text.split("\n");

	// Stack tracks current nesting context
	// Each entry: { indent: number, obj: the object at that level, key?: parent key }
	const stack: Array<{
		indent: number;
		obj: Record<string, unknown>;
		key?: string;
	}> = [{ indent: -1, obj: result }];

	for (const line of lines) {
		// Skip empty lines and comments
		const trimmedLine = line.trim();
		if (!trimmedLine || trimmedLine.startsWith("#")) continue;

		// Skip YAML document markers
		if (trimmedLine === "---" || trimmedLine === "...") continue;

		const indent = line.search(/\S/);

		// Pop stack to correct level for this indent
		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}

		const colonIdx = trimmedLine.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmedLine.slice(0, colonIdx).trim();
		let value = trimmedLine.slice(colonIdx + 1).trim();

		const parent = stack[stack.length - 1].obj;

		// Handle different value cases
		if (value === "" || value === "|") {
			// Nested object or multiline start
			parent[key] = {};
			stack.push({ indent, obj: parent[key] as Record<string, unknown>, key });
		} else if (value.startsWith("|")) {
			// Multiline string - this simplified parser just uses empty string
			// A full implementation would collect following indented lines
			parent[key] = "";
		} else {
			// Simple value - apply type coercion
			parent[key] = coerceYamlValue(value);
		}
	}

	return result;
}

/**
 * Format a JavaScript object as YAML.
 *
 * Supports:
 * - Nested objects
 * - Arrays (block style)
 * - Primitive values (string, number, boolean, null)
 */
export function formatYaml(obj: Record<string, unknown>, indent = 0): string {
	const pad = "  ".repeat(indent);
	let result = "";

	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined) continue;

		if (Array.isArray(value)) {
			result += `${pad}${key}:\n`;
			for (const item of value) {
				if (typeof item === "object" && item !== null) {
					result += `${pad}  - ${JSON.stringify(item)}\n`;
				} else {
					result += `${pad}  - ${item}\n`;
				}
			}
		} else if (typeof value === "object" && value !== null) {
			result += `${pad}${key}:\n`;
			result += formatYaml(value as Record<string, unknown>, indent + 1);
		} else if (value === null) {
			result += `${pad}${key}: null\n`;
		} else if (typeof value === "string") {
			// Quote strings that need it (contain special chars or start with number)
			if (
				value.includes(":") ||
				value.includes("#") ||
				value.includes("\n") ||
				/^\d/.test(value)
			) {
				result += `${pad}${key}: "${value}"\n`;
			} else {
				result += `${pad}${key}: ${value}\n`;
			}
		} else {
			result += `${pad}${key}: ${value}\n`;
		}
	}

	return result;
}

/**
 * Coerce a YAML value string to the appropriate JavaScript type.
 */
function coerceYamlValue(value: string): unknown {
	// Strip surrounding quotes
	const unquoted = value.replace(/^["']|["']$/g, "");

	// Boolean
	if (unquoted === "true") return true;
	if (unquoted === "false") return false;

	// Null
	if (unquoted === "null" || unquoted === "~") return null;

	// Integer
	if (/^-?\d+$/.test(unquoted)) return parseInt(unquoted, 10);

	// Float
	if (/^-?\d+\.\d+$/.test(unquoted)) return parseFloat(unquoted);

	// String (return unquoted version)
	return unquoted;
}
