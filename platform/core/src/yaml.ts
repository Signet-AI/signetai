import YAML from "yaml";
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
export function parseRuntimeYaml(text: string): Record<string, unknown> {
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
export function parseYamlDocument(text: string): unknown {
	return YAML.parse(text);
}
export function stringifyYamlDocument(value: unknown): string {
	return YAML.stringify(value);
}
export function formatYaml(obj: Record<string, unknown>, _indent = 0): string {
	return YAML.stringify(obj, {
		indent: 2,
		simpleKeys: true,
	});
}
