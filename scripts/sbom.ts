#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ShippedPackage, shippedArtifacts, shippedPackagesDir } from "./shipped-packages";

const severities = ["low", "moderate", "high", "critical"] as const;
type Severity = (typeof severities)[number];

export interface Advisory {
	readonly url: string;
	readonly title: string;
	readonly severity: Severity;
	readonly vulnerable_versions: string;
}

export interface Finding extends Advisory {
	readonly name: string;
	readonly version: string;
}

interface Component {
	readonly type: "library";
	readonly "bom-ref": string;
	readonly name: string;
	readonly version: string;
	readonly purl: string;
	readonly properties: readonly { readonly name: "signet:artifact"; readonly value: string }[];
}

function purl(item: ShippedPackage): string {
	return `pkg:npm/${item.name.replace(/^@/, "%40")}@${item.version}`;
}

function parsePackages(path: string): ShippedPackage[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${path} is not a non-empty package list`);
	return parsed.map((entry: unknown) => {
		if (typeof entry !== "object" || entry === null || !("name" in entry) || !("version" in entry)) {
			throw new Error(`${path} has an invalid package entry`);
		}
		const { name, version } = entry;
		if (typeof name !== "string" || typeof version !== "string") throw new Error(`${path} has an invalid entry`);
		return { name, version };
	});
}

export function buildSbom(dir: string, version: string): object {
	const missing = shippedArtifacts.filter((artifact) => !existsSync(join(dir, `${artifact}.json`)));
	if (missing.length > 0) {
		throw new Error(`Missing shipped package records for: ${missing.join(", ")}. Build every release artifact first.`);
	}
	const artifacts = new Map<string, { readonly item: ShippedPackage; readonly in: Set<string> }>();
	for (const artifact of shippedArtifacts) {
		for (const item of parsePackages(join(dir, `${artifact}.json`))) {
			const key = purl(item);
			const entry = artifacts.get(key) ?? { item, in: new Set<string>() };
			entry.in.add(artifact);
			artifacts.set(key, entry);
		}
	}
	const components: Component[] = [...artifacts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => ({
			type: "library",
			"bom-ref": key,
			name: entry.item.name,
			version: entry.item.version,
			purl: key,
			properties: [...entry.in].sort().map((value) => ({ name: "signet:artifact", value })),
		}));
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.6",
		version: 1,
		metadata: {
			component: { type: "application", "bom-ref": purl({ name: "signetai", version }), name: "signetai", version },
		},
		components,
	};
}

export function sbomPackages(sbom: unknown): ShippedPackage[] {
	if (typeof sbom !== "object" || sbom === null || !("components" in sbom) || !Array.isArray(sbom.components)) {
		throw new Error("SBOM has no components");
	}
	return sbom.components.flatMap((component: unknown) => {
		if (typeof component !== "object" || component === null || !("purl" in component)) return [];
		const { purl: value } = component;
		if (typeof value !== "string" || !value.startsWith("pkg:npm/")) return [];
		const at = value.lastIndexOf("@");
		return [{ name: decodeURIComponent(value.slice("pkg:npm/".length, at)), version: value.slice(at + 1) }];
	});
}

function field(value: object, key: string): unknown {
	return key in value ? Reflect.get(value, key) : undefined;
}

function isSeverity(value: unknown): value is Severity {
	return typeof value === "string" && severities.some((severity) => severity === value);
}

function parseAdvisories(body: unknown): Map<string, Advisory[]> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Error("Advisory response is not an object");
	}
	const result = new Map<string, Advisory[]>();
	for (const [name, list] of Object.entries(body)) {
		if (!Array.isArray(list)) throw new Error(`Advisory response for ${name} is not a list`);
		result.set(
			name,
			list.map((advisory: unknown) => {
				if (typeof advisory !== "object" || advisory === null) throw new Error(`Invalid advisory for ${name}`);
				const url = field(advisory, "url");
				const title = field(advisory, "title");
				const severity = field(advisory, "severity");
				const vulnerable_versions = field(advisory, "vulnerable_versions");
				if (
					typeof url !== "string" ||
					typeof title !== "string" ||
					!isSeverity(severity) ||
					typeof vulnerable_versions !== "string"
				) {
					throw new Error(`Invalid advisory for ${name}`);
				}
				return { url, title, severity, vulnerable_versions };
			}),
		);
	}
	return result;
}

export function findingsFor(packages: readonly ShippedPackage[], advisories: Map<string, Advisory[]>): Finding[] {
	return packages
		.flatMap((item) =>
			(advisories.get(item.name) ?? [])
				.filter((advisory) => Bun.semver.satisfies(item.version, advisory.vulnerable_versions))
				.map((advisory) => ({ ...advisory, name: item.name, version: item.version })),
		)
		.sort(
			(a, b) =>
				severities.indexOf(b.severity) - severities.indexOf(a.severity) ||
				`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
		);
}

export async function fetchAdvisories(
	packages: readonly ShippedPackage[],
	request: typeof fetch = fetch,
): Promise<Map<string, Advisory[]>> {
	const versions = new Map<string, Set<string>>();
	for (const item of packages) versions.set(item.name, (versions.get(item.name) ?? new Set()).add(item.version));
	const names = [...versions.keys()];
	const result = new Map<string, Advisory[]>();
	for (let index = 0; index < names.length; index += 100) {
		const body = Object.fromEntries(
			names.slice(index, index + 100).map((name) => [name, [...(versions.get(name) ?? [])]]),
		);
		const response = await request("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`npm advisory lookup failed with HTTP ${response.status}`);
		for (const [name, list] of parseAdvisories(await response.json())) result.set(name, list);
	}
	return result;
}

function artifactsOf(component: unknown): string[] {
	if (typeof component !== "object" || component === null) return [];
	const properties = field(component, "properties");
	if (!Array.isArray(properties)) return [];
	return properties.flatMap((property: unknown) =>
		typeof property === "object" &&
		property !== null &&
		field(property, "name") === "signet:artifact" &&
		typeof field(property, "value") === "string"
			? [String(field(property, "value"))]
			: [],
	);
}

export function sbomMismatches(sbom: unknown, dir: string): string[] {
	if (typeof sbom !== "object" || sbom === null) throw new Error("SBOM is not an object");
	const components = field(sbom, "components");
	if (!Array.isArray(components)) throw new Error("SBOM has no components");
	const present = shippedArtifacts.filter((artifact) => existsSync(join(dir, `${artifact}.json`)));
	if (present.length === 0) throw new Error(`No shipped package records in ${dir} to compare with the SBOM`);
	return present.flatMap((artifact) => {
		const built = new Set(parsePackages(join(dir, `${artifact}.json`)).map(purl));
		const audited = new Set(
			components.flatMap((component: unknown) => {
				const ref = typeof component === "object" && component !== null ? field(component, "purl") : undefined;
				return typeof ref === "string" && artifactsOf(component).includes(artifact) ? [ref] : [];
			}),
		);
		return [
			...[...built].filter((ref) => !audited.has(ref)).map((ref) => `${artifact}: ${ref} was built but not audited`),
			...[...audited].filter((ref) => !built.has(ref)).map((ref) => `${artifact}: ${ref} was audited but not built`),
		];
	});
}

async function audit(path: string, failOn: Severity): Promise<number> {
	const packages = sbomPackages(JSON.parse(readFileSync(path, "utf8")));
	if (packages.length === 0) throw new Error(`${path} lists no npm packages`);
	const findings = findingsFor(packages, await fetchAdvisories(packages));
	for (const finding of findings) {
		console.log(`${finding.severity}\t${finding.name}@${finding.version}\t${finding.title}\t${finding.url}`);
	}
	const blocking = findings.filter((finding) => severities.indexOf(finding.severity) >= severities.indexOf(failOn));
	console.log(
		`${packages.length} shipped packages, ${findings.length} advisories, ${blocking.length} at or above ${failOn}`,
	);
	return blocking.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	const [command, path, ...rest] = process.argv.slice(2);
	if (command === "generate" && path !== undefined) {
		const root: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
		const version =
			process.env.SIGNET_VERSION?.trim() ||
			(typeof root === "object" && root !== null ? field(root, "version") : undefined);
		if (typeof version !== "string") throw new Error("Cannot resolve the release version");
		writeFileSync(path, `${JSON.stringify(buildSbom(shippedPackagesDir, version), null, "\t")}\n`);
		console.log(`Wrote ${path}`);
	} else if (command === "audit" && path !== undefined) {
		const flag = rest.indexOf("--fail-on");
		const failOn = flag === -1 ? "high" : rest[flag + 1];
		if (!isSeverity(failOn)) throw new Error(`--fail-on must be one of ${severities.join(", ")}`);
		process.exit(await audit(path, failOn));
	} else if (command === "verify" && path !== undefined) {
		const mismatches = sbomMismatches(JSON.parse(readFileSync(path, "utf8")), shippedPackagesDir);
		for (const mismatch of mismatches) console.error(mismatch);
		if (mismatches.length > 0) process.exit(1);
		console.log(`This build matches ${path}`);
	} else {
		console.error(
			"usage: bun scripts/sbom.ts generate <out.cdx.json> | audit <sbom.cdx.json> [--fail-on <severity>] | verify <sbom.cdx.json>",
		);
		process.exit(2);
	}
}
