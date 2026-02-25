#!/usr/bin/env bun

/**
 * Compute semver bump level from conventional commit subjects.
 *
 * - `BREAKING CHANGE:` in subject or `!` after type → major
 * - `feat:` or `feat(scope):` → minor
 * - everything else → patch
 */

export type BumpLevel = "patch" | "minor" | "major";

export function computeBumpLevel(subjects: readonly string[]): BumpLevel {
	let level: BumpLevel = "patch";

	for (const subject of subjects) {
		if (
			subject.includes("BREAKING CHANGE:") ||
			/^\w+(?:\([^)]*\))?!:/.test(subject)
		) {
			return "major";
		}

		if (/^feat(?:\([^)]*\))?:/.test(subject)) {
			level = "minor";
		}
	}

	return level;
}
