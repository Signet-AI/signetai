import type { Skill, SkillSearchResult } from "$lib/api";

export type PermissionFootprint = "low" | "medium" | "high" | "unknown";

export type SkillLike = Partial<Skill & SkillSearchResult>;

export interface TrustProfile {
	compatibilityScore: number;
	securityConfidence: number;
	permissionFootprint: PermissionFootprint;
	verified: "yes" | "no" | "unknown";
	maintainer: string;
	compatibilityReason: string;
	securityReason: string;
}

const HIGH_RISK_PERMS = ["secrets", "network", "exec", "shell", "system"];
const MEDIUM_RISK_PERMS = ["write", "filesystem", "fs", "process", "clipboard"];

function clamp(value: number): number {
	if (value < 0) return 0;
	if (value > 100) return 100;
	return Math.round(value);
}

export function computePermissionFootprint(
	permissions: readonly string[] | undefined,
): PermissionFootprint {
	if (!permissions || permissions.length === 0) return "unknown";
	const lowered = permissions.map((p) => p.toLowerCase());
	const hasHigh = lowered.some((p) => HIGH_RISK_PERMS.some((k) => p.includes(k)));
	if (hasHigh) return "high";
	const hasMedium = lowered.some((p) => MEDIUM_RISK_PERMS.some((k) => p.includes(k)));
	if (hasMedium) return "medium";
	return "low";
}

export function computeTrustProfile(
	skill: SkillLike,
	installedNames: readonly string[],
): TrustProfile {
	const permissions = skill.permissions;
	const footprint = computePermissionFootprint(permissions);
	const installed = !!skill.name && installedNames.includes(skill.name);

	const maintainer =
		skill.maintainer ||
		skill.author ||
		(skill.fullName ? skill.fullName.split("@")[0] : "unknown");

	let compatibility = 40;
	if (skill.provider) compatibility += 15;
	if (skill.name) compatibility += 10;
	if (installed) compatibility += 20;
	if (skill.user_invocable) compatibility += 10;
	if (skill.builtin) compatibility += 15;

	let security = 50;
	if (skill.verified === true) security += 25;
	if (skill.verified === false) security -= 15;
	if (maintainer !== "unknown") security += 10;
	if ((skill.stars ?? 0) >= 100) security += 8;
	if ((skill.downloads ?? 0) >= 1000 || (skill.installsRaw ?? 0) >= 1000) security += 8;

	if (footprint === "high") security -= 20;
	if (footprint === "medium") security -= 8;
	if (footprint === "unknown") security -= 5;

	const verified: "yes" | "no" | "unknown" =
		skill.verified === true ? "yes" : skill.verified === false ? "no" : "unknown";

	const compatibilityReason = installed
		? "Already installed in this workspace."
		: skill.provider
			? `Published on ${skill.provider}.`
			: "Provider metadata is missing.";

	const securityReason =
		verified === "yes"
			? "Verified metadata present."
			: footprint === "unknown"
				? "Permissions metadata unavailable."
				: `Permissions footprint is ${footprint}.`;

	return {
		compatibilityScore: clamp(compatibility),
		securityConfidence: clamp(security),
		permissionFootprint: footprint,
		verified,
		maintainer,
		compatibilityReason,
		securityReason,
	};
}
