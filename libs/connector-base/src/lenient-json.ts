import { parse as parseJson5 } from "json5";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser/lib/esm/main.js";

/** Parse a connector config as JSONC or JSON5 and require an object root. */
export function parseLenientJsonObject(raw: string, options: { readonly label: string }): Record<string, unknown> {
	const source = raw.replace(/^\uFEFF/, "");
	const errors: ParseError[] = [];
	let parsed: unknown = parseJsonc(source, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});

	if (errors.length > 0) {
		try {
			parsed = parseJson5(source);
		} catch {
			const first = errors[0];
			if (!first) throw new Error(`Invalid ${options.label}`);
			throw new Error(`Invalid ${options.label} at offset ${first.offset} (${printParseErrorCode(first.error)})`);
		}
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${options.label}: expected a top-level object`);
	}
	return parsed as Record<string, unknown>;
}
