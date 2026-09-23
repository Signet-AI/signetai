export function normalizeRoutePath(path: string): string {
	return path
		.replace(/:[A-Za-z0-9_]+\{[^}]+\}/g, ":")
		.replace(/:[A-Za-z0-9_]+/g, ":")
		.replace(/\{[^}]+\}/g, ":")
		.replace(/\/+$/, "")
		.toLowerCase();
}

export function expandRoutePattern(template: string, constants: Record<string, readonly string[]>): string[] {
	const expressions = [...template.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)];
	if (template.includes("${") && expressions.length !== (template.match(/\$\{/g) ?? []).length) return [];
	if (expressions.some(([, name]) => name === undefined || !constants[name]?.length)) return [];
	let paths = [template.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, "\u0000$1\u0000")];
	for (const [, name] of expressions) {
		if (name === undefined) return [];
		const values = constants[name];
		if (values === undefined) return [];
		paths = paths.flatMap((path) => values.map((value) => path.replace(`\u0000${name}\u0000`, value)));
	}
	return paths;
}
