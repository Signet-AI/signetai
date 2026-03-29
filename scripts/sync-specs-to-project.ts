#!/usr/bin/env bun

/**
 * Syncs docs/specs/dependencies.yaml to a GitHub Projects v2 board.
 * YAML is the source of truth. The board is a read-friendly kanban view.
 *
 * Usage:
 *   bun scripts/sync-specs-to-project.ts          # full sync
 *   bun scripts/sync-specs-to-project.ts --dry-run # preview changes
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// --- config ---

const PROJECT_ID = "PVT_kwDOD4vxcc4BTHDc";
const PROJECT_NUMBER = 1;
const ORG = "Signet-AI";
const REPO = "signetai";

const FIELD = {
	title: "PVTF_lADOD4vxcc4BTHDczhAcoGA",
	status: "PVTSSF_lADOD4vxcc4BTHDczhAcoGI",
	tier: "PVTSSF_lADOD4vxcc4BTHDczhAcoIk",
	decision: "PVTSSF_lADOD4vxcc4BTHDczhAcoIo",
	specId: "PVTF_lADOD4vxcc4BTHDczhAcoIs",
	hardDeps: "PVTF_lADOD4vxcc4BTHDczhAcoIw",
	blocks: "PVTF_lADOD4vxcc4BTHDczhAcoI0",
	specPath: "PVTF_lADOD4vxcc4BTHDczhAcoI4",
} as const;

const TIER_OPTIONS: Record<string, string> = {
	research: "80da02c5",
	planning: "f7e2bb2e",
	approved: "1cb7637b",
	complete: "0747187f",
	reference: "b05ddbe9",
};

const STATUS_OPTIONS: Record<string, string> = {
	todo: "f75ad846",
	in_progress: "47fc9ee4",
	done: "98236657",
};

const DECISION_OPTIONS: Record<string, string> = {
	active: "df62f047",
	deferred: "a5ce3627",
	superseded: "2bbba4ef",
	discarded: "b95a033f",
};

// tier -> built-in status mapping
function tierToStatus(tier: string): string {
	if (tier === "complete") return STATUS_OPTIONS.done;
	if (tier === "approved") return STATUS_OPTIONS.in_progress;
	return STATUS_OPTIONS.todo;
}

// --- yaml parser (reused from spec-deps-check.ts) ---

interface Spec {
	id: string;
	status: string;
	path: string;
	hardDeps: string[];
	softDeps: string[];
	blocks: string[];
	informed: string[];
	criteria: string[];
	decision: string | null;
}

function strip(v: string): string {
	const t = v.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function parseYaml(raw: string): Spec[] {
	const lines = raw.split(/\r?\n/);
	const specs: Spec[] = [];
	let inSpecs = false;
	let cur: Spec | null = null;
	type ArrayKey = "hardDeps" | "softDeps" | "blocks" | "informed" | "criteria";
	let arrKey: ArrayKey | null = null;

	const keyMap: Record<string, ArrayKey> = {
		hard_depends_on: "hardDeps",
		soft_depends_on: "softDeps",
		blocks: "blocks",
		informed_by: "informed",
		success_criteria: "criteria",
	};

	for (const raw of lines) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;

		if (/^specs:\s*$/.test(raw)) {
			inSpecs = true;
			arrKey = null;
			continue;
		}
		if (!inSpecs) continue;

		const start = raw.match(/^\s{2}-\s+id:\s*(.+?)\s*$/);
		if (start) {
			if (cur) specs.push(cur);
			cur = { id: strip(start[1]), status: "", path: "", hardDeps: [], softDeps: [], blocks: [], informed: [], criteria: [], decision: null };
			arrKey = null;
			continue;
		}
		if (!cur) continue;

		// empty array
		for (const [yaml, key] of Object.entries(keyMap)) {
			const pat = new RegExp(`^\\s{4}${yaml}:\\s*\\[\\s*\\]\\s*$`);
			if (pat.test(raw)) {
				cur[key] = [];
				arrKey = null;
				break;
			}
		}

		// array start
		for (const [yaml, key] of Object.entries(keyMap)) {
			const pat = new RegExp(`^\\s{4}${yaml}:\\s*$`);
			if (pat.test(raw)) {
				arrKey = key;
				break;
			}
		}

		const item = raw.match(/^\s{6}-\s+(.+?)\s*$/);
		if (item && arrKey) {
			cur[arrKey].push(strip(item[1]));
			continue;
		}

		const scalar = raw.match(/^\s{4}([a-z_]+):\s*(.+?)\s*$/);
		if (scalar) {
			const [, k, v] = scalar;
			const val = strip(v);
			if (k === "status") cur.status = val;
			if (k === "path") cur.path = val;
			if (k === "decision") cur.decision = val === "null" ? null : val;
			arrKey = null;
		}
	}
	if (cur) specs.push(cur);
	return specs;
}

// --- graphql helpers ---

function gql(query: string): unknown {
	const escaped = query.replace(/'/g, "'\\''");
	const result = execSync(`gh api graphql -f query='${escaped}'`, {
		encoding: "utf8",
		timeout: 30_000,
	});
	return JSON.parse(result);
}

interface ProjectItem {
	id: string;
	specId: string | null;
	content: { title: string } | null;
}

function fetchItems(): ProjectItem[] {
	const items: ProjectItem[] = [];
	let cursor: string | null = null;

	for (;;) {
		const after = cursor ? `, after: "${cursor}"` : "";
		const res = gql(`
{
  node(id: "${PROJECT_ID}") {
    ... on ProjectV2 {
      items(first: 100${after}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on DraftIssue { title }
            ... on Issue { title }
          }
          fieldValueByName(name: "Spec ID") {
            ... on ProjectV2ItemFieldTextValue { text }
          }
        }
      }
    }
  }
}`) as {
			data: {
				node: {
					items: {
						pageInfo: { hasNextPage: boolean; endCursor: string };
						nodes: Array<{
							id: string;
							content: { title: string } | null;
							fieldValueByName: { text: string } | null;
						}>;
					};
				};
			};
		};

		const page = res.data.node.items;
		for (const n of page.nodes) {
			items.push({
				id: n.id,
				specId: n.fieldValueByName?.text ?? null,
				content: n.content,
			});
		}
		if (!page.pageInfo.hasNextPage) break;
		cursor = page.pageInfo.endCursor;
	}
	return items;
}

function addDraft(title: string): string {
	const res = gql(`
mutation {
  addProjectV2DraftIssue(input: {
    projectId: "${PROJECT_ID}"
    title: "${title.replace(/"/g, '\\"')}"
  }) {
    projectItem { id }
  }
}`) as { data: { addProjectV2DraftIssue: { projectItem: { id: string } } } };
	return res.data.addProjectV2DraftIssue.projectItem.id;
}

function setText(itemId: string, fieldId: string, value: string): void {
	gql(`
mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "${PROJECT_ID}"
    itemId: "${itemId}"
    fieldId: "${fieldId}"
    value: { text: "${value.replace(/"/g, '\\"')}" }
  }) {
    projectV2Item { id }
  }
}`);
}

function setSelect(itemId: string, fieldId: string, optionId: string): void {
	gql(`
mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "${PROJECT_ID}"
    itemId: "${itemId}"
    fieldId: "${fieldId}"
    value: { singleSelectOptionId: "${optionId}" }
  }) {
    projectV2Item { id }
  }
}`);
}

// --- title formatting ---

function formatTitle(spec: Spec): string {
	return spec.id
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// --- main ---

function main(): void {
	const dry = process.argv.includes("--dry-run");
	const root = process.cwd();
	const raw = readFileSync(resolve(root, "docs/specs/dependencies.yaml"), "utf8");
	const specs = parseYaml(raw);

	console.log(`parsed ${specs.length} specs from dependencies.yaml`);

	if (dry) {
		console.log("\n[dry run] would sync these specs:\n");
		for (const s of specs) {
			const tier = TIER_OPTIONS[s.status] ? s.status : "planning";
			const decision = s.decision ?? "active";
			console.log(`  ${s.id} | tier=${tier} | decision=${decision} | deps=${s.hardDeps.length} | blocks=${s.blocks.length}`);
		}
		console.log(`\nproject: https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}`);
		return;
	}

	console.log("fetching existing project items...");
	const existing = fetchItems();
	const bySpec = new Map<string, string>();
	for (const item of existing) {
		if (item.specId) bySpec.set(item.specId, item.id);
	}
	console.log(`found ${existing.length} existing items (${bySpec.size} with spec IDs)`);

	let created = 0;
	let updated = 0;

	for (const spec of specs) {
		const title = formatTitle(spec);
		let itemId = bySpec.get(spec.id);

		if (!itemId) {
			console.log(`  + ${spec.id}`);
			itemId = addDraft(title);
			created++;
		} else {
			console.log(`  ~ ${spec.id}`);
			updated++;
		}

		// set all fields
		setText(itemId, FIELD.specId, spec.id);
		setText(itemId, FIELD.specPath, spec.path);
		setText(itemId, FIELD.hardDeps, spec.hardDeps.join(", ") || "none");
		setText(itemId, FIELD.blocks, spec.blocks.join(", ") || "none");

		const tierOpt = TIER_OPTIONS[spec.status];
		if (tierOpt) {
			setSelect(itemId, FIELD.tier, tierOpt);
			setSelect(itemId, FIELD.status, tierToStatus(spec.status));
		}

		const decision = spec.decision ?? "active";
		const decOpt = DECISION_OPTIONS[decision];
		if (decOpt) {
			setSelect(itemId, FIELD.decision, decOpt);
		}
	}

	console.log(`\ndone: ${created} created, ${updated} updated`);
	console.log(`view: https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}`);
}

main();
