#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SpecRecord {
	id: string;
	status: string;
	path: string;
	hardDependsOn: string[];
	softDependsOn: string[];
	blocks: string[];
	informedBy: string[];
	successCriteria: string[];
	decision: string | null;
}

interface ParsedDeps {
	version: number;
	updatedAt: string;
	specs: SpecRecord[];
}

interface IndexRow {
	id: string;
	status: string;
	path: string;
}

const ROOT = process.cwd();
const DEPS_PATH = resolve(ROOT, "docs/specs/dependencies.yaml");
const INDEX_PATH = resolve(ROOT, "docs/specs/INDEX.md");

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseDepsYaml(yaml: string): ParsedDeps {
	const lines = yaml.split(/\r?\n/);
	let version = 0;
	let updatedAt = "";
	const specs: SpecRecord[] = [];

	let inSpecs = false;
	let current: SpecRecord | null = null;
	let currentArrayKey: "hardDependsOn" | "softDependsOn" | "blocks" | "informedBy" | "successCriteria" | null = null;

	for (const rawLine of lines) {
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
			continue;
		}

		if (/^specs:\s*$/.test(rawLine)) {
			inSpecs = true;
			currentArrayKey = null;
			continue;
		}

		if (!inSpecs) {
			const topMatch = rawLine.match(/^([a-z_]+):\s*(.+?)\s*$/);
			if (!topMatch) continue;
			const [, key, valueRaw] = topMatch;
			const value = stripQuotes(valueRaw);
			if (key === "version") {
				const parsed = Number.parseInt(value, 10);
				if (Number.isNaN(parsed)) {
					throw new Error(`Invalid version in dependencies file: ${value}`);
				}
				version = parsed;
			} else if (key === "updated_at") {
				updatedAt = value;
			}
			continue;
		}

		const specStart = rawLine.match(/^\s{2}-\s+id:\s*(.+?)\s*$/);
		if (specStart) {
			if (current !== null) {
				specs.push(current);
			}
			current = {
				id: stripQuotes(specStart[1]),
				status: "",
				path: "",
				hardDependsOn: [],
				softDependsOn: [],
				blocks: [],
				informedBy: [],
				successCriteria: [],
				decision: null,
			};
			currentArrayKey = null;
			continue;
		}

		if (current === null) {
			continue;
		}

		if (/^\s{4}hard_depends_on:\s*\[\s*\]\s*$/.test(rawLine)) {
			current.hardDependsOn = [];
			currentArrayKey = null;
			continue;
		}
		if (/^\s{4}soft_depends_on:\s*\[\s*\]\s*$/.test(rawLine)) {
			current.softDependsOn = [];
			currentArrayKey = null;
			continue;
		}
		if (/^\s{4}blocks:\s*\[\s*\]\s*$/.test(rawLine)) {
			current.blocks = [];
			currentArrayKey = null;
			continue;
		}
		if (/^\s{4}informed_by:\s*\[\s*\]\s*$/.test(rawLine)) {
			current.informedBy = [];
			currentArrayKey = null;
			continue;
		}
		if (/^\s{4}success_criteria:\s*\[\s*\]\s*$/.test(rawLine)) {
			current.successCriteria = [];
			currentArrayKey = null;
			continue;
		}

		if (/^\s{4}hard_depends_on:\s*$/.test(rawLine)) {
			currentArrayKey = "hardDependsOn";
			continue;
		}
		if (/^\s{4}soft_depends_on:\s*$/.test(rawLine)) {
			currentArrayKey = "softDependsOn";
			continue;
		}
		if (/^\s{4}blocks:\s*$/.test(rawLine)) {
			currentArrayKey = "blocks";
			continue;
		}
		if (/^\s{4}informed_by:\s*$/.test(rawLine)) {
			currentArrayKey = "informedBy";
			continue;
		}
		if (/^\s{4}success_criteria:\s*$/.test(rawLine)) {
			currentArrayKey = "successCriteria";
			continue;
		}

		const arrayItem = rawLine.match(/^\s{6}-\s+(.+?)\s*$/);
		if (arrayItem && currentArrayKey !== null) {
			current[currentArrayKey].push(stripQuotes(arrayItem[1]));
			continue;
		}

		const scalar = rawLine.match(/^\s{4}([a-z_]+):\s*(.+?)\s*$/);
		if (scalar) {
			const [, key, valueRaw] = scalar;
			const value = stripQuotes(valueRaw);
			if (key === "status") current.status = value;
			if (key === "path") current.path = value;
			if (key === "decision") current.decision = value === "null" ? null : value;
			currentArrayKey = null;
		}
	}

	if (current !== null) {
		specs.push(current);
	}

	return { version, updatedAt, specs };
}

function parseIndexRows(markdown: string): IndexRow[] {
	const lines = markdown.split(/\r?\n/);
	const rows: IndexRow[] = [];

	let inRegistry = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (line === "## Spec Registry") {
			inRegistry = true;
			continue;
		}

		if (!inRegistry) continue;

		if (line.startsWith("## ") && line !== "## Spec Registry") {
			break;
		}

		if (!line.startsWith("|")) continue;
		if (line.includes("---")) continue;

		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter((cell) => cell.length > 0);
		if (cells.length < 3) continue;
		if (cells[0] === "ID") continue;

		const id = stripQuotes(cells[0]).replace(/`/g, "");
		const status = stripQuotes(cells[1]).replace(/`/g, "");
		const path = stripQuotes(cells[2]).replace(/`/g, "");

		rows.push({ id, status, path });
	}

	return rows;
}

function detectHardDepCycles(specs: SpecRecord[]): string[][] {
	const byId = new Map(specs.map((spec) => [spec.id, spec]));
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const cycles: string[][] = [];

	for (const spec of specs) {
		color.set(spec.id, 0);
	}

	function dfs(id: string): void {
		color.set(id, 1);
		stack.push(id);

		const spec = byId.get(id);
		if (spec !== undefined) {
			for (const dep of spec.hardDependsOn) {
				if (!byId.has(dep)) continue;
				const depColor = color.get(dep) ?? 0;
				if (depColor === 0) {
					dfs(dep);
				} else if (depColor === 1) {
					const cycleStart = stack.indexOf(dep);
					if (cycleStart >= 0) {
						cycles.push(stack.slice(cycleStart).concat(dep));
					}
				}
			}
		}

		stack.pop();
		color.set(id, 2);
	}

	for (const spec of specs) {
		if ((color.get(spec.id) ?? 0) === 0) {
			dfs(spec.id);
		}
	}

	return cycles;
}

function main(): void {
	const failures: string[] = [];

	if (!existsSync(DEPS_PATH)) {
		throw new Error(`Missing dependency file: ${DEPS_PATH}`);
	}
	if (!existsSync(INDEX_PATH)) {
		throw new Error(`Missing spec index file: ${INDEX_PATH}`);
	}

	const deps = parseDepsYaml(readFileSync(DEPS_PATH, "utf8"));
	const indexRows = parseIndexRows(readFileSync(INDEX_PATH, "utf8"));

	if (deps.version <= 0) {
		failures.push("dependencies.yaml must declare a positive version");
	}
	if (deps.updatedAt.length === 0) {
		failures.push("dependencies.yaml must declare updated_at");
	}

	const allowedStatuses = new Set(["planning", "approved", "complete", "reference"]);

	const ids = new Set<string>();
	for (const spec of deps.specs) {
		if (!spec.id) {
			failures.push("spec entry with empty id");
			continue;
		}
		if (ids.has(spec.id)) {
			failures.push(`duplicate spec id in dependencies.yaml: ${spec.id}`);
		}
		ids.add(spec.id);

		if (!allowedStatuses.has(spec.status)) {
			failures.push(`invalid status for ${spec.id}: ${spec.status} (allowed: planning|approved|complete|reference)`);
		}

		if (!spec.path) {
			failures.push(`missing path for ${spec.id}`);
		} else if (!existsSync(resolve(ROOT, spec.path))) {
			failures.push(`path does not exist for ${spec.id}: ${spec.path}`);
		}
	}

	const allowedDecisions = new Set(["deferred", "superseded", "discarded"]);

	const statusDirMap: Record<string, string> = {
		complete: "docs/specs/complete/",
		approved: "docs/specs/approved/",
		planning: "docs/specs/planning/",
	};

	for (const spec of deps.specs) {
		if (spec.decision !== null && !allowedDecisions.has(spec.decision)) {
			failures.push(`invalid decision for ${spec.id}: ${spec.decision} (allowed: deferred|superseded|discarded)`);
		}

		for (const ref of spec.informedBy) {
			if (/^(arxiv:|https?:|doi:)/.test(ref)) continue;
			if (!existsSync(resolve(ROOT, ref))) {
				failures.push(`informed_by path does not exist for ${spec.id}: ${ref}`);
			}
		}

		const expectedDir = statusDirMap[spec.status];
		if (expectedDir && spec.path && !spec.path.startsWith(expectedDir)) {
			if (spec.status !== "reference") {
				failures.push(
					`status/directory mismatch for ${spec.id}: status=${spec.status} but path=${spec.path} (expected ${expectedDir})`,
				);
			}
		}
	}

	for (const spec of deps.specs) {
		for (const dep of spec.hardDependsOn) {
			if (!ids.has(dep)) {
				failures.push(`${spec.id} hard_depends_on unknown spec id: ${dep}`);
			}
		}

		for (const dep of spec.softDependsOn) {
			if (!ids.has(dep)) {
				failures.push(`${spec.id} soft_depends_on unknown spec id: ${dep}`);
			}
		}

		for (const dep of spec.blocks) {
			if (!ids.has(dep)) {
				failures.push(`${spec.id} blocks unknown spec id: ${dep}`);
			}
		}
	}

	const cycles = detectHardDepCycles(deps.specs);
	for (const cycle of cycles) {
		failures.push(`hard dependency cycle detected: ${cycle.join(" -> ")}`);
	}

	const indexMap = new Map(indexRows.map((row) => [row.id, row]));
	for (const spec of deps.specs) {
		const row = indexMap.get(spec.id);
		if (row === undefined) {
			failures.push(`spec missing from INDEX.md registry: ${spec.id}`);
			continue;
		}
		if (row.status !== spec.status) {
			failures.push(`status drift for ${spec.id}: dependencies.yaml=${spec.status}, INDEX.md=${row.status}`);
		}
		if (row.path !== spec.path) {
			failures.push(`path drift for ${spec.id}: dependencies.yaml=${spec.path}, INDEX.md=${row.path}`);
		}
	}

	for (const row of indexRows) {
		if (!ids.has(row.id)) {
			failures.push(`INDEX.md registry has unknown spec id: ${row.id}`);
		}
	}

	if (failures.length > 0) {
		console.error("Spec dependency check failed:\n");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}

	console.log(`Spec dependency check passed (${deps.specs.length} specs, ${indexRows.length} indexed).`);
}

main();
