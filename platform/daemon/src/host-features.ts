import { z } from "zod";
import assignments from "./host-features.json";

export const HOST_FEATURES = [
	"sources.github",
	"sources.filesystem",
	"sources.discord",
	"git.sync",
	"plugins.manage",
	"secrets.providers",
	"inference.local",
	"harness.repair",
	"config.apply",
	"skills.manage",
	"graphiq.manage",
	"daemon.update",
] as const;
export const hostFeatureSchema = z.enum(HOST_FEATURES);
export type HostFeature = z.infer<typeof hostFeatureSchema>;
export const remoteHostFeaturesSchema = z
	.array(hostFeatureSchema)
	.max(HOST_FEATURES.length)
	.refine((items) => new Set(items).size === items.length);
export const NEVER_REMOTE_ROUTES = [
	"GET /api/secrets/exec/:jobId",
	"POST /api/graphiq/index",
	"POST /api/hooks/compaction-complete",
	"POST /api/hooks/notifications",
	"POST /api/hooks/pre-compaction",
	"POST /api/hooks/recall",
	"POST /api/hooks/remember",
	"POST /api/hooks/session-checkpoint-extract",
	"POST /api/hooks/session-end",
	"POST /api/hooks/session-end/uploads",
	"POST /api/hooks/session-start",
	"POST /api/hooks/skill-invocation",
	"POST /api/hooks/stop",
	"POST /api/hooks/synthesis",
	"POST /api/hooks/synthesis/complete",
	"POST /api/hooks/user-prompt-submit",
	"POST /api/secrets/:name/exec",
	"POST /api/secrets/exec",
	"POST /api/sources/import",
	"POST /api/sources/pick-directory",
	"POST /api/sources/pick-files",
	"POST /api/troubleshoot/exec",
] as const;
const reviewed = z.record(z.string(), hostFeatureSchema).parse(assignments);
for (const route of NEVER_REMOTE_ROUTES)
	if (Object.hasOwn(reviewed, route)) throw new Error(`Conflicting remote policy: ${route}`);
function pattern(path: string): RegExp {
	const normalized = path.replace(/\$\{action\}/g, "__harness_action__").replace(/\$\{[^}]+\}/g, ":action");
	return new RegExp(
		`^${normalized
			.split("/")
			.map((part) =>
				part === "__harness_action__"
					? "(?:connect|disconnect|repair|reinitialize)"
					: part.startsWith(":")
						? "[^/]+"
						: part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("/")}/?$`,
	);
}
const routes = [
	...Object.entries(reviewed).map(([route, feature]) => ({ route, feature })),
	...NEVER_REMOTE_ROUTES.map((route) => ({ route, feature: "never-remote" as const })),
].map(({ route, feature }) => {
	const separator = route.indexOf(" ");
	return { route, method: route.slice(0, separator), path: pattern(route.slice(separator + 1)), feature };
});
export function hostFeatureAssignment(method: string, path: string): HostFeature | "never-remote" | undefined {
	const exact = routes.find((entry) => entry.route === `${method} ${path}`);
	if (exact) return exact.feature;
	const matched = routes.filter((entry) => entry.method === method && entry.path.test(path));
	if (matched.some((entry) => entry.feature === "never-remote")) return "never-remote";
	const features = new Set(matched.map((entry) => entry.feature));
	return features.size === 1 ? matched[0]?.feature : undefined;
}
let allowed: readonly HostFeature[] = [];
export function replaceRemoteHostFeatures(input: unknown): void {
	allowed = Object.freeze(remoteHostFeaturesSchema.parse(input));
}
export function remoteHostFeatures(): readonly HostFeature[] {
	return allowed;
}
export function remoteHostFeatureAllowed(feature: HostFeature): boolean {
	return allowed.includes(feature);
}
export function remoteHostFeatureStatus() {
	return {
		features: HOST_FEATURES.map((name) => ({ name, allowed: allowed.includes(name) })),
		neverRemote: NEVER_REMOTE_ROUTES,
	};
}
