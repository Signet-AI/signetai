#!/usr/bin/env bun

export type BumpLevel = "patch" | "minor" | "major";

export function computeBumpLevel(subjects: readonly string[]): BumpLevel {
	let level: BumpLevel = "patch";

	for (const subject of subjects) {
		if (subject.includes("BREAKING CHANGE:") || /^\w+(?:\([^)]*\))?!:/.test(subject)) {
			return "major";
		}

		if (/^feat(?:\([^)]*\))?:/.test(subject)) {
			level = "minor";
		}
	}

	return level;
}
