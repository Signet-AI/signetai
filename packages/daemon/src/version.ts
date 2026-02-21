interface ParsedVersion {
	readonly core: readonly number[];
	readonly prerelease: readonly string[];
}

function parseVersion(value: string): ParsedVersion | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	const withoutPrefix = trimmed.replace(/^v/i, "");
	const withoutBuild = withoutPrefix.split("+")[0] ?? "";
	if (!withoutBuild) return null;

	const prereleaseIndex = withoutBuild.indexOf("-");
	const corePart =
		prereleaseIndex >= 0
			? withoutBuild.slice(0, prereleaseIndex)
			: withoutBuild;
	const prereleasePart =
		prereleaseIndex >= 0 ? withoutBuild.slice(prereleaseIndex + 1) : "";

	const coreSegments = corePart.split(".");
	if (coreSegments.some((segment) => !/^\d+$/.test(segment))) {
		return null;
	}

	const core = coreSegments.map((segment) => Number.parseInt(segment, 10));
	const prerelease = prereleasePart
		? prereleasePart.split(".").filter(Boolean)
		: [];

	if (prerelease.some((segment) => !/^[0-9A-Za-z-]+$/.test(segment))) {
		return null;
	}

	return { core, prerelease };
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;

	const maxLength = Math.max(a.length, b.length);

	for (let i = 0; i < maxLength; i += 1) {
		const left = a[i];
		const right = b[i];

		if (left === undefined) return -1;
		if (right === undefined) return 1;

		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);

		if (leftNumeric && rightNumeric) {
			const leftValue = Number.parseInt(left, 10);
			const rightValue = Number.parseInt(right, 10);
			if (leftValue !== rightValue) {
				return leftValue > rightValue ? 1 : -1;
			}
			continue;
		}

		if (leftNumeric && !rightNumeric) return -1;
		if (!leftNumeric && rightNumeric) return 1;

		if (left !== right) {
			return left > right ? 1 : -1;
		}
	}

	return 0;
}

export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);

	if (!left || !right) {
		const normalizedA = a.trim().replace(/^v/i, "");
		const normalizedB = b.trim().replace(/^v/i, "");
		if (normalizedA === normalizedB) return 0;
		return normalizedA > normalizedB ? 1 : -1;
	}

	const maxLength = Math.max(left.core.length, right.core.length);

	for (let i = 0; i < maxLength; i += 1) {
		const leftPart = left.core[i] ?? 0;
		const rightPart = right.core[i] ?? 0;

		if (leftPart !== rightPart) {
			return leftPart > rightPart ? 1 : -1;
		}
	}

	return comparePrerelease(left.prerelease, right.prerelease);
}

export function isVersionNewer(latest: string, current: string): boolean {
	return compareVersions(latest, current) > 0;
}
