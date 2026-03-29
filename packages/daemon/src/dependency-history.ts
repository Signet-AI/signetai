import type { DependencyType } from "@signet/core";

export const RELATED_TO_REASON_ERROR =
	"related_to dependencies require a non-empty reason";

function squashReason(raw: string): string {
	return raw.trim().replace(/\s+/g, " ").slice(0, 300);
}

export function normalizeDependencyReason(
	dependencyType: DependencyType,
	reason?: string | null,
): string | null {
	if (typeof reason !== "string") {
		if (dependencyType === "related_to") return null;
		return null;
	}

	const text = squashReason(reason);
	if (text.length === 0) {
		if (dependencyType === "related_to") return null;
		return null;
	}

	return text;
}

export function requireDependencyReason(
	dependencyType: DependencyType,
	reason?: string | null,
): string | null {
	const text = normalizeDependencyReason(dependencyType, reason);
	if (dependencyType === "related_to" && text === null) {
		throw new Error(RELATED_TO_REASON_ERROR);
	}
	return text;
}

