import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";

interface OntologyDeps {
	readonly ensureDaemonForSecrets: () => Promise<boolean>;
	readonly secretApiCall: (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number,
	) => Promise<{
		ok: boolean;
		data: unknown;
	}>;
}

interface ProposalListItem {
	readonly id?: string;
	readonly operation?: string;
	readonly status?: string;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly updatedAt?: string;
}

interface ProposalListResponse {
	readonly items?: readonly ProposalListItem[];
}

interface OntologyObjectEntity {
	readonly id?: string;
	readonly name?: string;
	readonly entityType?: string;
	readonly canonicalName?: string;
}

interface OntologyObjectItem {
	readonly entity?: OntologyObjectEntity;
	readonly aspectCount?: number;
	readonly attributeCount?: number;
	readonly constraintCount?: number;
	readonly dependencyCount?: number;
}

interface OntologyObjectListResponse {
	readonly items?: readonly OntologyObjectItem[];
}

interface EntityAliasItem {
	readonly id?: string;
	readonly alias?: string;
	readonly canonicalAlias?: string;
	readonly confidence?: number;
	readonly source?: string | null;
	readonly status?: string;
}

interface EntityAliasListResponse {
	readonly items?: readonly EntityAliasItem[];
}

interface OntologyClaimItem {
	readonly claimKey?: string;
	readonly activeCount?: number;
	readonly supersededCount?: number;
}

interface OntologyClaimsResponse {
	readonly items?: readonly OntologyClaimItem[];
}

interface OntologyLinkItem {
	readonly id?: string;
	readonly direction?: string;
	readonly dependencyType?: string;
	readonly strength?: number;
	readonly sourceEntityName?: string;
	readonly targetEntityName?: string;
	readonly reason?: string | null;
}

interface OntologyLinksResponse {
	readonly items?: readonly OntologyLinkItem[];
}

interface EvidenceItem {
	readonly kind?: string;
	readonly found?: boolean;
	readonly label?: string;
	readonly excerpt?: string;
}

interface EvidenceResponse {
	readonly items?: readonly EvidenceItem[];
}

interface ClaimEvidenceAttribute {
	readonly content?: string;
	readonly status?: string;
	readonly confidence?: number;
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
}

interface ClaimEvidenceValue {
	readonly attribute?: ClaimEvidenceAttribute;
	readonly evidence?: readonly EvidenceItem[];
}

interface ClaimEvidenceResponse {
	readonly items?: readonly ClaimEvidenceValue[];
}

interface EpistemicAssertionItem {
	readonly id?: string;
	readonly subjectEntityName?: string | null;
	readonly predicate?: string;
	readonly content?: string;
	readonly speaker?: string | null;
	readonly assertedAt?: string;
	readonly confidence?: number;
	readonly status?: string;
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
	readonly claimAttributeId?: string | null;
}

interface EpistemicAssertionsResponse {
	readonly items?: readonly EpistemicAssertionItem[];
}

interface ConflictValue {
	readonly proposalId?: string;
	readonly value?: string;
	readonly confidence?: number;
}

interface ConflictItem {
	readonly entity?: string;
	readonly aspect?: string;
	readonly groupKey?: string;
	readonly claimKey?: string;
	readonly values?: readonly ConflictValue[];
}

interface ConflictsResponse {
	readonly items?: readonly ConflictItem[];
}

interface RepairDuplicateEntity {
	readonly name?: string;
	readonly id?: string;
	readonly entityType?: string;
	readonly mentions?: number;
	readonly pinned?: boolean;
}

interface RepairDuplicateItem {
	readonly canonicalName?: string;
	readonly target?: RepairDuplicateEntity;
	readonly sources?: readonly RepairDuplicateEntity[];
	readonly impact?: EntityMergeImpact;
	readonly warnings?: readonly string[];
	readonly blocked?: boolean;
	readonly risk?: string;
	readonly rationale?: string;
}

interface RepairDuplicatesResponse {
	readonly items?: readonly RepairDuplicateItem[];
	readonly writtenCount?: number;
	readonly skippedCount?: number;
	readonly dryRun?: boolean;
}

interface EntityMergeImpact {
	readonly sourceMentions?: number;
	readonly memoryMentions?: number;
	readonly aspects?: number;
	readonly attributes?: number;
	readonly dependencies?: number;
	readonly relations?: number;
}

interface EntityMergePlanResponse {
	readonly target?: RepairDuplicateEntity;
	readonly sources?: readonly RepairDuplicateEntity[];
	readonly impact?: EntityMergeImpact;
	readonly warnings?: readonly string[];
	readonly blocked?: boolean;
	readonly risk?: string;
	readonly rationale?: string;
	readonly dryRun?: boolean;
	readonly proposal?: ProposalListItem;
}

interface ProposalImportInput {
	readonly operation: string;
	readonly payload: Record<string, unknown>;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
	readonly risk?: string;
}

interface ExtractionResponse {
	readonly proposals?: readonly ProposalImportInput[];
	readonly assertions?: readonly EpistemicAssertionItem[];
	readonly count?: number;
	readonly writtenCount?: number;
	readonly assertionCount?: number;
	readonly writtenAssertionCount?: number;
	readonly dryRun?: boolean;
	readonly extractionMode?: string;
	readonly providerName?: string | null;
	readonly questions?: readonly string[];
	readonly warnings?: readonly string[];
	readonly source?: {
		readonly kind?: string;
		readonly id?: string;
		readonly sourcePath?: string | null;
	};
}

interface ConsolidationResponse {
	readonly proposals?: readonly ProposalImportInput[];
	readonly sourceProposalCount?: number;
	readonly count?: number;
	readonly writtenCount?: number;
	readonly dryRun?: boolean;
	readonly consolidationMode?: string;
	readonly providerName?: string | null;
	readonly summary?: string | null;
	readonly warnings?: readonly string[];
	readonly rejections?: readonly unknown[];
	readonly conflicts?: readonly unknown[];
	readonly maintenance?: readonly unknown[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] | undefined {
	const value = record[key];
	return Array.isArray(value) ? value : undefined;
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`Could not read JSON file ${path}: ${message}`));
		process.exit(1);
	}
}

function readPayloadFile(path: string): Record<string, unknown> {
	const payload = readJsonFile(path);
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		console.error(chalk.red("Payload file must contain a JSON object"));
		process.exit(1);
	}
	return payload as Record<string, unknown>;
}

function readEvidenceFile(path: string | undefined): readonly unknown[] | undefined {
	if (!path) return undefined;
	const evidence = readJsonFile(path);
	if (Array.isArray(evidence)) return evidence;
	return [evidence];
}

function readProposalFile(path: string): readonly ProposalImportInput[] {
	return normalizeProposalFile(readJsonFile(path));
}

function readTextFileOrStdin(path: string): string {
	if (path === "-") return readFileSync(0, "utf8");
	return readFileSync(path, "utf8");
}

function readOperationJsonl(path: string): readonly Record<string, unknown>[] {
	return readTextFileOrStdin(path)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line, index) => {
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
				throw new Error("line is not an object");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(chalk.red(`Invalid JSONL operation on line ${index + 1}: ${message}`));
				process.exit(1);
			}
		});
}

function proposalInput(
	operation: string | undefined,
	payload: Record<string, unknown>,
	src: Record<string, unknown>,
	fallbackRationale: string,
): ProposalImportInput | null {
	if (!operation || Object.keys(payload).length === 0) return null;
	return {
		operation,
		payload,
		confidence: readNumber(src, "confidence"),
		rationale: readString(src, "rationale") ?? readString(src, "reason") ?? fallbackRationale,
		evidence: readArray(src, "evidence"),
		risk: readString(src, "risk"),
	};
}

function payloadRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));
}

function normalizeExplicitProposal(value: unknown): ProposalImportInput | null {
	const src = asRecord(value);
	return proposalInput(readString(src, "operation"), asRecord(src.payload), src, "Imported ontology proposal.");
}

function normalizeExtractionEntities(root: Record<string, unknown>): ProposalImportInput[] {
	return (readArray(root, "entities") ?? [])
		.map((raw) => {
			const entity = asRecord(raw);
			const name = readString(entity, "name");
			if (!name) return null;
			return proposalInput(
				"create_entity",
				payloadRecord([
					["name", name],
					["entity_type", readString(entity, "type") ?? readString(entity, "entity_type")],
				]),
				entity,
				"Extracted entity candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalImportInput => proposal !== null);
}

function normalizeExtractionClaims(root: Record<string, unknown>): ProposalImportInput[] {
	return (readArray(root, "claim_values") ?? [])
		.map((raw) => {
			const claim = asRecord(raw);
			const entity = readString(claim, "entity");
			const aspect = readString(claim, "aspect");
			const claimKey = readString(claim, "claim_key");
			const value = readString(claim, "value");
			if (!entity || !aspect || !claimKey || !value) return null;
			const payload = payloadRecord([
				["entity", entity],
				["entity_type", readString(claim, "entity_type")],
				["aspect", aspect],
				["group_key", readString(claim, "group_key")],
				["claim_key", claimKey],
				["value", value],
				["visibility", readString(claim, "visibility")],
				["reducer_hint", readString(claim, "reducer_hint")],
				["confidence", readNumber(claim, "confidence")],
			]);
			return proposalInput("add_claim_value", payload, claim, "Extracted claim value candidate from source evidence.");
		})
		.filter((proposal): proposal is ProposalImportInput => proposal !== null);
}

function normalizeExtractionLinks(root: Record<string, unknown>): ProposalImportInput[] {
	return (readArray(root, "links") ?? [])
		.map((raw) => {
			const link = asRecord(raw);
			const source = readString(link, "source_entity");
			const target = readString(link, "target_entity");
			const linkType = readString(link, "link_type");
			if (!source || !target || !linkType) return null;
			const payload = payloadRecord([
				["source_entity", source],
				["source_type", readString(link, "source_type")],
				["link_type", linkType],
				["target_entity", target],
				["target_type", readString(link, "target_type")],
				["properties", asRecord(link.properties)],
				["reason", readString(link, "reason")],
				["confidence", readNumber(link, "confidence")],
			]);
			return proposalInput("create_link", payload, link, "Extracted typed link candidate from source evidence.");
		})
		.filter((proposal): proposal is ProposalImportInput => proposal !== null);
}

function normalizeExtractionPolicies(root: Record<string, unknown>): ProposalImportInput[] {
	return (readArray(root, "actions_or_policies") ?? [])
		.map((raw) => {
			const policy = asRecord(raw);
			const target = readString(policy, "target_entity");
			const kind = readString(policy, "kind");
			const content = readString(policy, "content");
			if (!target || !kind || !content) return null;
			const payload = payloadRecord([
				["target_entity", target],
				["kind", kind],
				["content", content],
			]);
			return proposalInput(
				"create_policy",
				payload,
				policy,
				"Extracted action or policy candidate from source evidence.",
			);
		})
		.filter((proposal): proposal is ProposalImportInput => proposal !== null);
}

function normalizeProposalFile(raw: unknown): readonly ProposalImportInput[] {
	if (Array.isArray(raw)) {
		return raw.map(normalizeExplicitProposal).filter((proposal): proposal is ProposalImportInput => proposal !== null);
	}
	const root = asRecord(raw);
	const explicit = readArray(root, "proposals");
	if (explicit) {
		return explicit
			.map(normalizeExplicitProposal)
			.filter((proposal): proposal is ProposalImportInput => proposal !== null);
	}
	return [
		...normalizeExtractionEntities(root),
		...normalizeExtractionClaims(root),
		...normalizeExtractionLinks(root),
		...normalizeExtractionPolicies(root),
	];
}

function appendAgent(params: URLSearchParams, agent?: string): void {
	if (agent) params.set("agent_id", agent);
}

function errorMessage(data: unknown, fallback: string): string {
	const raw = asRecord(data).error;
	return typeof raw === "string" ? raw : fallback;
}

async function apiGet(deps: OntologyDeps, path: string, params: URLSearchParams): Promise<unknown> {
	const query = params.toString();
	const { ok, data } = await deps.secretApiCall("GET", query ? `${path}?${query}` : path, undefined, 10_000);
	if (!ok || typeof asRecord(data).error === "string") {
		console.error(chalk.red(errorMessage(data, "Ontology request failed")));
		process.exit(1);
	}
	return data;
}

async function apiPost(deps: OntologyDeps, path: string, body: unknown, timeoutMs = 15_000): Promise<unknown> {
	const { ok, data } = await deps.secretApiCall("POST", path, body, timeoutMs);
	if (!ok || typeof asRecord(data).error === "string") {
		console.error(chalk.red(errorMessage(data, "Ontology request failed")));
		process.exit(1);
	}
	return data;
}

async function apiDelete(deps: OntologyDeps, path: string, timeoutMs = 10_000): Promise<unknown> {
	const { ok, data } = await deps.secretApiCall("DELETE", path, undefined, timeoutMs);
	if (!ok || typeof asRecord(data).error === "string") {
		console.error(chalk.red(errorMessage(data, "Ontology request failed")));
		process.exit(1);
	}
	return data;
}

function printProposalList(data: unknown): void {
	const items = ((asRecord(data) as ProposalListResponse).items ?? []) as readonly ProposalListItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No ontology proposals found"));
		return;
	}
	console.log(chalk.bold("\n  Ontology Proposals\n"));
	for (const item of items) {
		const id = item.id ?? "unknown";
		const status = item.status ?? "unknown";
		const confidence = typeof item.confidence === "number" ? ` · ${item.confidence.toFixed(2)}` : "";
		console.log(`  ${chalk.cyan(id)} ${chalk.dim(status)} ${chalk.yellow(item.operation ?? "unknown")}${confidence}`);
		if (item.rationale) console.log(chalk.dim(`    ${item.rationale}`));
		if (item.updatedAt) console.log(chalk.dim(`    updated ${item.updatedAt}`));
	}
	console.log();
}

function countLabel(value: number | undefined, noun: string): string {
	const n = value ?? 0;
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function objectName(entity: OntologyObjectEntity | undefined): string {
	return entity?.name ?? entity?.canonicalName ?? "unknown";
}

function printOntologyObjects(data: unknown): void {
	const items = ((asRecord(data) as OntologyObjectListResponse).items ?? []) as readonly OntologyObjectItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No ontology objects found"));
		return;
	}
	console.log(chalk.bold("\n  Ontology Objects\n"));
	for (const item of items) {
		const type = item.entity?.entityType ? chalk.dim(` (${item.entity.entityType})`) : "";
		console.log(`  ${chalk.cyan(objectName(item.entity))}${type}`);
		console.log(
			chalk.dim(
				`    ${countLabel(item.aspectCount, "aspect")} · ${countLabel(item.attributeCount, "attribute")} · ${countLabel(
					item.constraintCount,
					"constraint",
				)} · ${countLabel(item.dependencyCount, "link")}`,
			),
		);
		if (item.entity?.id) console.log(chalk.dim(`    ${item.entity.id}`));
	}
	console.log();
}

function printEntityAliases(data: unknown): void {
	const items = ((asRecord(data) as EntityAliasListResponse).items ?? []) as readonly EntityAliasItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No aliases found"));
		return;
	}
	console.log(chalk.bold("\n  Entity Aliases\n"));
	for (const item of items) {
		const status = item.status ? chalk.dim(` ${item.status}`) : "";
		const confidence = typeof item.confidence === "number" ? chalk.dim(` · ${item.confidence.toFixed(2)}`) : "";
		console.log(`  ${chalk.cyan(item.alias ?? "unknown")} ${chalk.dim(item.id ?? "unknown")}${status}${confidence}`);
		if (item.source) console.log(chalk.dim(`    source ${item.source}`));
	}
	console.log();
}

function printOntologyClaims(data: unknown): void {
	const items = ((asRecord(data) as OntologyClaimsResponse).items ?? []) as readonly OntologyClaimItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No ontology claims found"));
		return;
	}
	console.log(chalk.bold("\n  Ontology Claims\n"));
	for (const item of items) {
		console.log(`  ${chalk.cyan(item.claimKey ?? "unknown")}`);
		console.log(chalk.dim(`    ${item.activeCount ?? 0} active · ${item.supersededCount ?? 0} old`));
	}
	console.log();
}

function printOntologyLinks(data: unknown): void {
	const items = ((asRecord(data) as OntologyLinksResponse).items ?? []) as readonly OntologyLinkItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No ontology links found"));
		return;
	}
	console.log(chalk.bold("\n  Ontology Links\n"));
	for (const item of items) {
		const strength = typeof item.strength === "number" ? ` · ${item.strength.toFixed(2)}` : "";
		console.log(
			`  ${chalk.yellow(item.dependencyType ?? "link")} ${chalk.dim(item.direction ?? "both")}${strength} ${chalk.cyan(
				item.sourceEntityName ?? "unknown",
			)} -> ${chalk.cyan(item.targetEntityName ?? "unknown")}`,
		);
		if (item.reason) console.log(chalk.dim(`    ${item.reason}`));
	}
	console.log();
}

function printEvidence(data: unknown, title = "Proposal Evidence"): void {
	const items = ((asRecord(data) as EvidenceResponse).items ?? []) as readonly EvidenceItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No evidence references found"));
		return;
	}
	console.log(chalk.bold(`\n  ${title}\n`));
	for (const item of items) {
		const marker = item.found === false ? chalk.red("missing") : chalk.green("found");
		console.log(`  ${marker} ${chalk.yellow(item.kind ?? "unknown")} ${chalk.cyan(item.label ?? "")}`);
		if (item.excerpt) console.log(chalk.dim(`    ${item.excerpt}`));
	}
	console.log();
}

function printClaimEvidence(data: unknown): void {
	const items = ((asRecord(data) as ClaimEvidenceResponse).items ?? []) as readonly ClaimEvidenceValue[];
	if (items.length === 0) {
		console.log(chalk.dim("  No claim values found"));
		return;
	}
	console.log(chalk.bold("\n  Claim Evidence\n"));
	for (const item of items) {
		const attr = item.attribute;
		const confidence = typeof attr?.confidence === "number" ? ` · ${attr.confidence.toFixed(2)}` : "";
		console.log(`  ${chalk.cyan(attr?.status ?? "unknown")}${confidence}`);
		if (attr?.content) console.log(chalk.dim(`    ${attr.content}`));
		const source = attr?.sourcePath ?? attr?.sourceId ?? attr?.sourceKind;
		if (source) console.log(chalk.dim(`    source ${source}`));
		for (const evidence of item.evidence ?? []) {
			const marker = evidence.found === false ? chalk.red("missing") : chalk.green("found");
			console.log(`    ${marker} ${chalk.yellow(evidence.kind ?? "unknown")} ${chalk.cyan(evidence.label ?? "")}`);
			if (evidence.excerpt) console.log(chalk.dim(`      ${evidence.excerpt}`));
		}
	}
	console.log();
}

function printAssertions(data: unknown, title = "Epistemic Assertions"): void {
	const record = asRecord(data);
	const items = (((record as EpistemicAssertionsResponse).items as readonly EpistemicAssertionItem[] | undefined) ??
		(record.id ? ([record as EpistemicAssertionItem] as const) : [])) as readonly EpistemicAssertionItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No epistemic assertions found"));
		return;
	}
	console.log(chalk.bold(`\n  ${title}\n`));
	for (const item of items) {
		const confidence = typeof item.confidence === "number" ? ` · ${item.confidence.toFixed(2)}` : "";
		const status = item.status ? chalk.dim(` ${item.status}`) : "";
		console.log(
			`  ${chalk.cyan(item.id ?? "unknown")}${status} ${chalk.yellow(item.predicate ?? "claims")}${confidence}`,
		);
		const actor = item.speaker ?? item.sourcePath ?? item.sourceId ?? item.sourceKind;
		const when = item.assertedAt ? ` · ${item.assertedAt}` : "";
		console.log(chalk.dim(`    ${item.subjectEntityName ?? "unknown"}${actor ? ` · ${actor}` : ""}${when}`));
		if (item.content) console.log(chalk.dim(`    ${item.content}`));
		if (item.claimAttributeId) console.log(chalk.dim(`    claim ${item.claimAttributeId}`));
	}
	console.log();
}

function printConflicts(data: unknown): void {
	const items = ((asRecord(data) as ConflictsResponse).items ?? []) as readonly ConflictItem[];
	if (items.length === 0) {
		console.log(chalk.dim("  No pending proposal conflicts found"));
		return;
	}
	console.log(chalk.bold("\n  Pending Proposal Conflicts\n"));
	for (const item of items) {
		const title = `${item.entity ?? "unknown"} / ${item.aspect ?? "unknown"} / ${item.groupKey ?? "general"} / ${
			item.claimKey ?? "unknown"
		}`;
		console.log(`  ${chalk.yellow(title)}`);
		for (const value of item.values ?? []) {
			const confidence = typeof value.confidence === "number" ? ` · ${value.confidence.toFixed(2)}` : "";
			console.log(`    ${chalk.cyan(value.proposalId ?? "unknown")}${confidence} ${value.value ?? ""}`);
		}
	}
	console.log();
}

function printDuplicateRepairs(data: unknown): void {
	const record = asRecord(data) as RepairDuplicatesResponse;
	const items = record.items ?? [];
	const writtenCount = record.writtenCount ?? 0;
	const skippedCount = record.skippedCount ?? 0;
	if (items.length === 0) {
		console.log(chalk.dim("  No duplicate entity merge candidates found"));
		return;
	}

	const mode = record.dryRun === false ? "Duplicate Merge Refactor Proposals" : "Duplicate Merge Candidates";
	console.log(chalk.bold(`\n  ${mode}\n`));
	for (const item of items) {
		const target = item.target?.name ?? "unknown";
		const sources = (item.sources ?? []).map((source) => source.name ?? source.id ?? "unknown").join(", ");
		const marker = item.blocked ? chalk.red("blocked") : item.risk ? chalk.dim(item.risk) : "";
		console.log(`  ${chalk.yellow(item.canonicalName ?? "unknown")} ${chalk.cyan(target)} <- ${sources} ${marker}`);
		if (item.impact) {
			console.log(
				chalk.dim(
					`    ${item.impact.aspects ?? 0} aspects · ${item.impact.attributes ?? 0} attributes · ${
						item.impact.memoryMentions ?? 0
					} mentions`,
				),
			);
		}
		for (const warning of item.warnings ?? []) console.log(chalk.yellow(`    warning ${warning}`));
		if (item.rationale) console.log(chalk.dim(`    ${item.rationale}`));
	}
	if (writtenCount > 0) console.log(chalk.green(`\n  Created ${writtenCount} pending merge refactor proposals`));
	if (skippedCount > 0) console.log(chalk.yellow(`  Skipped ${skippedCount} blocked merge candidate(s)`));
	console.log();
}

function printEntityMergePlan(data: unknown): void {
	const result = asRecord(data) as EntityMergePlanResponse;
	const target = result.target?.name ?? result.target?.id ?? "unknown";
	const sources = result.sources ?? [];
	const title = result.blocked
		? chalk.red("Entity Merge Blocked")
		: result.proposal
			? "Entity Merge Refactor Proposal"
			: "Entity Merge Plan";
	console.log(chalk.bold(`\n  ${title}\n`));
	console.log(
		`  ${chalk.cyan(target)} <- ${sources.map((source) => source.name ?? source.id ?? "unknown").join(", ")}`,
	);
	if (result.target?.id) console.log(chalk.dim(`    target ${result.target.id}`));
	for (const source of sources) {
		if (source.id)
			console.log(chalk.dim(`    source ${source.id}${source.entityType ? ` (${source.entityType})` : ""}`));
	}
	if (result.impact) {
		console.log(
			chalk.dim(
				`    ${result.impact.aspects ?? 0} aspects · ${result.impact.attributes ?? 0} attributes · ${
					result.impact.dependencies ?? 0
				} links · ${result.impact.memoryMentions ?? 0} mentions`,
			),
		);
	}
	for (const warning of result.warnings ?? []) console.log(chalk.yellow(`    warning ${warning}`));
	if (result.rationale) console.log(chalk.dim(`    ${result.rationale}`));
	if (result.proposal?.id) console.log(chalk.green(`\n  Created pending proposal ${result.proposal.id}`));
	console.log();
}

function printExtraction(data: unknown): void {
	const result = asRecord(data) as ExtractionResponse;
	const proposals = result.proposals ?? [];
	const source = result.source?.sourcePath ?? result.source?.id ?? "unknown source";
	console.log(chalk.bold("\n  Ontology Extraction\n"));
	console.log(chalk.dim(`  source ${source}`));
	console.log(chalk.dim(`  mode ${result.extractionMode ?? "unknown"}`));
	if (result.providerName) console.log(chalk.dim(`  provider ${result.providerName}`));
	console.log(chalk.dim(`  ${result.writtenCount ?? 0} written · ${result.count ?? proposals.length} candidate(s)`));
	if ((result.assertionCount ?? 0) > 0 || (result.writtenAssertionCount ?? 0) > 0) {
		console.log(
			chalk.dim(
				`  ${result.writtenAssertionCount ?? 0} assertions written · ${result.assertionCount ?? 0} assertion candidate(s)`,
			),
		);
	}
	for (const warning of result.warnings ?? []) {
		console.log(chalk.yellow(`  warning ${warning}`));
	}
	for (const proposal of proposals.slice(0, 20)) {
		const confidence = typeof proposal.confidence === "number" ? ` · ${proposal.confidence.toFixed(2)}` : "";
		console.log(`  ${chalk.yellow(proposal.operation)}${confidence}`);
		if (proposal.rationale) console.log(chalk.dim(`    ${proposal.rationale}`));
		const payload = asRecord(proposal.payload);
		const label = payload.name ?? payload.entity ?? payload.source_entity ?? payload.target_entity;
		if (typeof label === "string") console.log(chalk.dim(`    ${label}`));
	}
	if (proposals.length > 20) console.log(chalk.dim(`  ... ${proposals.length - 20} more`));
	if (result.questions && result.questions.length > 0) {
		console.log(chalk.bold("\n  Questions"));
		for (const question of result.questions.slice(0, 10)) console.log(chalk.dim(`  - ${question}`));
		if (result.questions.length > 10) console.log(chalk.dim(`  ... ${result.questions.length - 10} more`));
	}
	console.log();
}

function printConsolidation(data: unknown): void {
	const result = asRecord(data) as ConsolidationResponse;
	const proposals = result.proposals ?? [];
	console.log(chalk.bold("\n  Ontology Consolidation\n"));
	console.log(chalk.dim(`  mode ${result.consolidationMode ?? "unknown"}`));
	if (result.providerName) console.log(chalk.dim(`  provider ${result.providerName}`));
	console.log(
		chalk.dim(
			`  ${result.sourceProposalCount ?? 0} source proposal(s) · ${result.writtenCount ?? 0} written · ${
				result.count ?? proposals.length
			} candidate(s)`,
		),
	);
	if (result.summary) console.log(chalk.dim(`  ${result.summary}`));
	for (const warning of result.warnings ?? []) {
		console.log(chalk.yellow(`  warning ${warning}`));
	}
	for (const proposal of proposals.slice(0, 20)) {
		const confidence = typeof proposal.confidence === "number" ? ` · ${proposal.confidence.toFixed(2)}` : "";
		console.log(`  ${chalk.yellow(proposal.operation)}${confidence}`);
		if (proposal.rationale) console.log(chalk.dim(`    ${proposal.rationale}`));
	}
	if ((result.rejections ?? []).length > 0) console.log(chalk.dim(`  ${result.rejections?.length ?? 0} rejection(s)`));
	if ((result.conflicts ?? []).length > 0)
		console.log(chalk.dim(`  ${result.conflicts?.length ?? 0} conflict note(s)`));
	if ((result.maintenance ?? []).length > 0)
		console.log(chalk.dim(`  ${result.maintenance?.length ?? 0} maintenance note(s)`));
	console.log();
}

function addCommonOptions(cmd: Command): Command {
	return cmd.option("--agent <name>", "Agent scope, default default").option("--json", "Output as JSON");
}

function addOperationOptions(cmd: Command): Command {
	return addCommonOptions(cmd)
		.option("--dry-run", "Validate and preview without writing")
		.option("--propose", "Create a pending proposal for large refactor review instead of applying")
		.option("--actor <name>", "Audit actor", "operator")
		.option("--reason <text>", "Audit reason")
		.option("--evidence-file <path>", "JSON evidence file, array or single object");
}

function operationBody(
	operation: string,
	payload: Record<string, unknown>,
	options: Record<string, unknown>,
): Record<string, unknown> {
	return {
		agent_id: options.agent,
		actor: options.actor,
		operation,
		payload,
		reason: options.reason,
		evidence: readEvidenceFile(typeof options.evidenceFile === "string" ? options.evidenceFile : undefined),
		dry_run: options.dryRun === true,
		propose: options.propose === true,
	};
}

async function postOperation(
	deps: OntologyDeps,
	operation: string,
	payload: Record<string, unknown>,
	options: Record<string, unknown>,
): Promise<unknown> {
	if (options.dryRun && options.propose) {
		console.error(chalk.red("--dry-run and --propose cannot be used together"));
		process.exit(1);
	}
	return apiPost(deps, "/api/ontology/operations/apply", operationBody(operation, payload, options));
}

function printOperationResult(data: unknown, options: Record<string, unknown>, label: string): void {
	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	const record = asRecord(data);
	const proposal = asRecord(record.proposal);
	const id = typeof proposal.id === "string" ? proposal.id : "";
	const mode = record.dryRun === true ? "Dry-run validated" : record.proposed === true ? "Proposed" : "Applied";
	console.log(chalk.green(`${mode} ${label}${id ? ` (${id})` : ""}`));
}

export function registerOntologyCommands(program: Command, deps: OntologyDeps): void {
	const ontology = program.command("ontology").description("Inspect and maintain the operational ontology");

	addCommonOptions(
		ontology
			.command("proposals")
			.description("List ontology maintenance proposals")
			.option("--status <status>", "pending, applied, rejected, or failed")
			.option("--operation <operation>", "Filter by operation")
			.option("-l, --limit <n>", "Max proposals to return", Number.parseInt)
			.option("--offset <n>", "Pagination offset", Number.parseInt),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		if (options.status) params.set("status", options.status);
		if (options.operation) params.set("operation", options.operation);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.offset !== undefined) params.set("offset", String(options.offset));
		const data = await apiGet(deps, "/api/ontology/proposals", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printProposalList(data);
	});

	addCommonOptions(
		ontology.command("proposal").description("Show one ontology proposal").argument("<id>", "Proposal id"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const data = await apiGet(deps, `/api/ontology/proposals/${encodeURIComponent(id)}`, params);
		console.log(JSON.stringify(data, null, 2));
	});

	addCommonOptions(
		ontology.command("evidence").description("Show evidence for one ontology proposal").argument("<id>", "Proposal id"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const data = await apiGet(deps, `/api/ontology/proposals/${encodeURIComponent(id)}/evidence`, params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEvidence(data);
	});

	addCommonOptions(
		ontology
			.command("link-evidence")
			.description("Show evidence for one applied ontology link")
			.argument("<id>", "Link id"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const data = await apiGet(deps, `/api/ontology/links/${encodeURIComponent(id)}/evidence`, params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEvidence(data, "Link Evidence");
	});

	addCommonOptions(
		ontology
			.command("claim-evidence")
			.description("Show evidence for applied ontology claim values")
			.argument("<entity>", "Entity/object name")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key")
			.argument("<claim>", "Claim key")
			.option("--kind <kind>", "attribute or constraint")
			.option("--status <status>", "active, superseded, deleted, or all")
			.option("-l, --limit <n>", "Max claim values to return", Number.parseInt)
			.option("--offset <n>", "Pagination offset", Number.parseInt),
	).action(async (entity: string, aspect: string, group: string, claim: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity, aspect, group, claim });
		appendAgent(params, options.agent);
		if (options.kind) params.set("kind", options.kind);
		if (options.status) params.set("status", options.status);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.offset !== undefined) params.set("offset", String(options.offset));
		const data = await apiGet(deps, "/api/ontology/claims/evidence", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printClaimEvidence(data);
	});

	addCommonOptions(
		ontology
			.command("conflicts")
			.description("Show pending claim-value proposal conflicts")
			.option("-l, --limit <n>", "Max pending proposals to scan", Number.parseInt),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		const data = await apiGet(deps, "/api/ontology/proposals/conflicts", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printConflicts(data);
	});

	addCommonOptions(
		ontology
			.command("assertions")
			.description("List source-attributed epistemic assertions")
			.option("--entity <name>", "Filter by entity name")
			.option("--entity-id <id>", "Filter by entity id")
			.option("--predicate <predicate>", "Filter by predicate")
			.option("--status <status>", "Filter by status", "active")
			.option("--speaker <name>", "Filter by speaker")
			.option("--source-kind <kind>", "Filter by source kind")
			.option("--source-id <id>", "Filter by source id")
			.option("--query <text>", "Filter assertion text")
			.option("-l, --limit <n>", "Max assertions to return", Number.parseInt),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		for (const [key, value] of [
			["entity", options.entity],
			["entity_id", options.entityId],
			["predicate", options.predicate],
			["status", options.status],
			["speaker", options.speaker],
			["source_kind", options.sourceKind],
			["source_id", options.sourceId],
			["query", options.query],
		] as const) {
			if (typeof value === "string" && value.length > 0) params.set(key, value);
		}
		if (typeof options.limit === "number") params.set("limit", String(options.limit));
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/ontology/assertions", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data);
	});

	const assertion = ontology.command("assertion").description("Inspect and maintain epistemic assertions");

	addCommonOptions(
		assertion.command("show").description("Show one epistemic assertion").argument("<id>", "Assertion id"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const data = await apiGet(deps, `/api/ontology/assertions/${encodeURIComponent(id)}`, params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Epistemic Assertion");
	});

	addCommonOptions(
		assertion
			.command("create")
			.description("Create a source-attributed epistemic assertion")
			.option("--entity <name>", "Subject entity name")
			.option("--entity-id <id>", "Subject entity id")
			.requiredOption("--predicate <predicate>", "claims|believes|observed|decided|prefers|denies|questions")
			.requiredOption("--content <text>", "Assertion content")
			.option("--speaker <name>", "Speaker or claimant")
			.option("--asserted-at <iso>", "When the assertion was made")
			.option("--confidence <n>", "Assertion confidence", Number.parseFloat)
			.option("--source-kind <kind>", "Evidence source kind")
			.option("--source-id <id>", "Evidence source id")
			.option("--source-path <path>", "Evidence source path")
			.option("--source-root <path>", "Evidence source root")
			.option("--claim-attribute-id <id>", "Applied claim attribute this assertion supports")
			.option("--evidence-file <path>", "JSON evidence file, array or single object")
			.option("--created-by <name>", "Audit creator", "operator"),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		if (!options.entity && !options.entityId) {
			console.error(chalk.red("--entity or --entity-id is required"));
			process.exit(1);
		}
		const body = {
			agent_id: options.agent,
			entity: options.entity,
			entity_id: options.entityId,
			predicate: options.predicate,
			content: options.content,
			speaker: options.speaker,
			asserted_at: options.assertedAt,
			confidence: options.confidence,
			source_kind: options.sourceKind,
			source_id: options.sourceId,
			source_path: options.sourcePath,
			source_root: options.sourceRoot,
			claim_attribute_id: options.claimAttributeId,
			evidence: readEvidenceFile(options.evidenceFile),
			created_by: options.createdBy,
		};
		const data = await apiPost(deps, "/api/ontology/assertions", body);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Created Epistemic Assertion");
	});

	addCommonOptions(
		assertion
			.command("link-claim")
			.description("Link an epistemic assertion to an applied claim attribute")
			.argument("<id>", "Assertion id")
			.requiredOption("--attribute-id <id>", "Claim attribute id"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const query = params.toString();
		const data = await apiPost(
			deps,
			`/api/ontology/assertions/${encodeURIComponent(id)}/link-claim${query ? `?${query}` : ""}`,
			{ attribute_id: options.attributeId },
		);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Linked Epistemic Assertion");
	});

	addCommonOptions(
		assertion
			.command("archive")
			.description("Archive an epistemic assertion")
			.argument("<id>", "Assertion id")
			.option("--reason <text>", "Archive reason")
			.option("--actor <name>", "Audit actor", "operator"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const query = params.toString();
		const data = await apiPost(
			deps,
			`/api/ontology/assertions/${encodeURIComponent(id)}/archive${query ? `?${query}` : ""}`,
			{ reason: options.reason, actor: options.actor },
		);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Archived Epistemic Assertion");
	});

	addCommonOptions(
		assertion
			.command("supersede")
			.description("Supersede an epistemic assertion with a newer assertion")
			.argument("<id>", "Assertion id")
			.requiredOption("--content <text>", "Replacement assertion content")
			.option("--predicate <predicate>", "Replacement predicate")
			.option("--speaker <name>", "Speaker or claimant")
			.option("--asserted-at <iso>", "When the replacement assertion was made")
			.option("--confidence <n>", "Assertion confidence", Number.parseFloat)
			.option("--source-kind <kind>", "Evidence source kind")
			.option("--source-id <id>", "Evidence source id")
			.option("--source-path <path>", "Evidence source path")
			.option("--source-root <path>", "Evidence source root")
			.option("--evidence-file <path>", "JSON evidence file, array or single object")
			.option("--created-by <name>", "Audit creator", "operator"),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const query = params.toString();
		const data = await apiPost(
			deps,
			`/api/ontology/assertions/${encodeURIComponent(id)}/supersede${query ? `?${query}` : ""}`,
			{
				predicate: options.predicate,
				content: options.content,
				speaker: options.speaker,
				asserted_at: options.assertedAt,
				confidence: options.confidence,
				source_kind: options.sourceKind,
				source_id: options.sourceId,
				source_path: options.sourcePath,
				source_root: options.sourceRoot,
				evidence: readEvidenceFile(options.evidenceFile),
				created_by: options.createdBy,
			},
		);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Superseding Epistemic Assertion");
	});

	addCommonOptions(
		assertion
			.command("import")
			.description("Import epistemic assertions from JSON")
			.requiredOption("--file <path>", "JSON assertion array or { assertions }")
			.option("--created-by <name>", "Audit creator", "operator"),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const raw = readJsonFile(options.file);
		const assertions = Array.isArray(raw) ? raw : (readArray(asRecord(raw), "assertions") ?? []);
		const written: unknown[] = [];
		for (const item of assertions) {
			const assertionRecord = asRecord(item);
			const data = await apiPost(deps, "/api/ontology/assertions", {
				...assertionRecord,
				agent_id: options.agent,
				created_by: readString(assertionRecord, "created_by") ?? options.createdBy,
			});
			written.push(data);
		}
		const data = { items: written, count: written.length };
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAssertions(data, "Imported Epistemic Assertions");
	});

	ontology
		.command("extract")
		.description("Extract candidate ontology proposals from a transcript or artifact")
		.requiredOption("--from <source>", "Source ref, e.g. transcript:<id>, artifact:<path>, or source:<path>")
		.option("--write-proposals", "Persist extracted candidates as pending proposals for explicit review")
		.option("--write-assertions", "Persist extracted epistemic assertions")
		.option("--dry-run", "Preview candidates without writing", true)
		.option("--use-provider", "Use the configured memory extraction inference workload")
		.option("--provider-timeout-ms <n>", "Provider extraction timeout in milliseconds", Number.parseInt)
		.option("--provider-max-tokens <n>", "Provider extraction response token budget", Number.parseInt)
		.option("-l, --limit <n>", "Max candidates to return", Number.parseInt)
		.option("--agent <name>", "Agent scope, default default")
		.option("--created-by <name>", "Audit creator", "ontology-extract")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await apiPost(
				deps,
				"/api/ontology/extract",
				{
					agent_id: options.agent,
					from: options.from,
					write_proposals: options.writeProposals === true,
					...(options.writeAssertions === true ? { write_assertions: true } : {}),
					use_provider: options.useProvider === true,
					provider_timeout_ms: options.providerTimeoutMs,
					provider_max_tokens: options.providerMaxTokens,
					created_by: options.createdBy,
					limit: options.limit,
				},
				options.useProvider === true ? Math.max(options.providerTimeoutMs ?? 90_000, 15_000) + 5_000 : 15_000,
			);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printExtraction(data);
		});

	ontology
		.command("consolidate")
		.description("Consolidate pending ontology proposals into higher-confidence proposals")
		.option("--proposals <status>", "Proposal status to consolidate", "pending")
		.option("--write-proposals", "Persist consolidated candidates as pending proposals for explicit review")
		.option("--dry-run", "Preview consolidated candidates without writing", true)
		.option("--use-provider", "Use the configured memory extraction inference workload")
		.option("--provider-timeout-ms <n>", "Provider consolidation timeout in milliseconds", Number.parseInt)
		.option("--provider-max-tokens <n>", "Provider consolidation response token budget", Number.parseInt)
		.option("-l, --limit <n>", "Max source proposals to consolidate", Number.parseInt)
		.option("--agent <name>", "Agent scope, default default")
		.option("--created-by <name>", "Audit creator", "ontology-consolidate")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await apiPost(
				deps,
				"/api/ontology/consolidate",
				{
					agent_id: options.agent,
					status: options.proposals,
					write_proposals: options.writeProposals === true,
					use_provider: options.useProvider === true,
					provider_timeout_ms: options.providerTimeoutMs,
					provider_max_tokens: options.providerMaxTokens,
					created_by: options.createdBy,
					limit: options.limit,
				},
				options.useProvider === true ? Math.max(options.providerTimeoutMs ?? 120_000, 15_000) + 5_000 : 15_000,
			);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printConsolidation(data);
		});

	addCommonOptions(
		ontology
			.command("objects")
			.description("List ontology objects backed by knowledge graph entities")
			.option("-q, --query <query>", "Optional object name filter")
			.option("--type <type>", "Optional object type filter")
			.option("-l, --limit <n>", "Max objects to return", Number.parseInt)
			.option("--offset <n>", "Pagination offset", Number.parseInt),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		if (options.query) params.set("q", options.query);
		if (options.type) params.set("type", options.type);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.offset !== undefined) params.set("offset", String(options.offset));
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/entities", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printOntologyObjects(data);
	});

	addCommonOptions(
		ontology
			.command("object")
			.description("Show one ontology object by id, or by name with --name")
			.argument("<id-or-name>", "Object id, or object name when --name is set")
			.option("--name", "Resolve the object by name instead of id"),
	).action(async (idOrName: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		if (options.name) {
			params.set("name", idOrName);
		}
		const data = options.name
			? await apiGet(deps, "/api/knowledge/navigation/entity", params)
			: await apiGet(deps, `/api/knowledge/entities/${encodeURIComponent(idOrName)}`, params);
		console.log(JSON.stringify(data, null, 2));
	});

	addCommonOptions(
		ontology
			.command("links")
			.description("List ontology links for an object id")
			.argument("<object-id>", "Object/entity id")
			.option("--direction <direction>", "incoming, outgoing, or both"),
	).action(async (objectId: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		if (options.direction) params.set("direction", options.direction);
		appendAgent(params, options.agent);
		const data = await apiGet(deps, `/api/knowledge/entities/${encodeURIComponent(objectId)}/dependencies`, params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printOntologyLinks(data);
	});

	addCommonOptions(
		ontology
			.command("claims")
			.description("List ontology claim slots under an object/aspect/group path")
			.argument("<entity>", "Entity/object name")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key"),
	).action(async (entity: string, aspect: string, group: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity, aspect, group });
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/claims", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printOntologyClaims(data);
	});

	const entity = ontology.command("entity").description("Apply audited entity operations");
	addOperationOptions(
		entity
			.command("create")
			.description("Create an entity")
			.argument("<name>", "Entity name")
			.requiredOption("--type <type>"),
	).action(async (name: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(deps, "create_entity", { name, entity_type: options.type }, options);
		printOperationResult(data, options, "entity create");
	});
	addOperationOptions(
		entity
			.command("rename")
			.description("Rename an entity")
			.argument("<selector>", "Entity id or exact canonical name")
			.argument("<new-name>", "New entity name"),
	).action(async (selector: string, newName: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(deps, "rename_entity", { selector, new_name: newName }, options);
		printOperationResult(data, options, "entity rename");
	});
	addOperationOptions(
		entity
			.command("merge")
			.description("Merge source entities into a target entity")
			.argument("<target>", "Target entity selector")
			.argument("<source...>", "Source entity selectors"),
	).action(async (target: string, source: readonly string[], options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"merge_entities",
			{ target_entity: target, source_entities: source },
			options,
		);
		printOperationResult(data, options, "entity merge");
	});
	addCommonOptions(
		entity
			.command("merge-plan")
			.description("Preview merge impact; optionally create a large-refactor proposal")
			.argument("<target>", "Target entity selector")
			.argument("<source...>", "Source entity selectors")
			.option("--propose", "Create a pending merge proposal for large refactor review")
			.option("--force", "Allow pinned or mixed-type source entities")
			.option("--created-by <name>", "Audit creator", "ontology-merge-plan")
			.option("--rationale <text>", "Short rationale")
			.option("--evidence-file <path>", "JSON evidence file, array or single object"),
	).action(async (target: string, source: readonly string[], options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await apiPost(deps, "/api/ontology/proposals/repair/merge-plan", {
			agent_id: options.agent,
			target_entity: target,
			source_entities: source,
			force: options.force === true,
			write_proposal: options.propose === true,
			created_by: options.createdBy,
			rationale: options.rationale,
			evidence: readEvidenceFile(typeof options.evidenceFile === "string" ? options.evidenceFile : undefined),
		});
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEntityMergePlan(data);
	});
	addOperationOptions(
		entity
			.command("archive")
			.description("Archive an entity")
			.argument("<selector>", "Entity id or exact canonical name"),
	).action(async (selector: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(deps, "archive_entity", { selector, reason: options.reason }, options);
		printOperationResult(data, options, "entity archive");
	});
	const alias = entity.command("alias").description("Manage entity aliases");
	addCommonOptions(
		alias
			.command("list")
			.description("List aliases for an entity id")
			.argument("<entity-id>")
			.option("--status <status>", "Alias status: active, archived, all"),
	).action(async (entityId: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		if (typeof options.status === "string") params.set("status", options.status);
		const data = await apiGet(deps, `/api/ontology/entities/${encodeURIComponent(entityId)}/aliases`, params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEntityAliases(data);
	});
	addCommonOptions(
		alias
			.command("add")
			.description("Add an alias for an entity id")
			.argument("<entity-id>")
			.argument("<alias>")
			.option("--confidence <n>", "Alias confidence 0..1", Number.parseFloat)
			.option("--source <text>", "Alias source label"),
	).action(async (entityId: string, aliasValue: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const query = params.toString();
		const data = await apiPost(
			deps,
			`/api/ontology/entities/${encodeURIComponent(entityId)}/aliases${query ? `?${query}` : ""}`,
			{
				alias: aliasValue,
				confidence: options.confidence,
				source: options.source,
			},
		);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEntityAliases({ items: [asRecord(data).item] });
	});
	addCommonOptions(
		alias.command("archive").description("Archive an entity alias").argument("<entity-id>").argument("<alias-id>"),
	).action(async (entityId: string, aliasId: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		appendAgent(params, options.agent);
		const query = params.toString();
		const data = await apiDelete(
			deps,
			`/api/ontology/entities/${encodeURIComponent(entityId)}/aliases/${encodeURIComponent(aliasId)}${
				query ? `?${query}` : ""
			}`,
		);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printEntityAliases({ items: [asRecord(data).item] });
	});

	const claim = ontology.command("claim").description("Apply audited claim/version operations");
	addOperationOptions(
		claim
			.command("set")
			.description("Set the current value for a claim")
			.argument("<entity>", "Entity selector")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key")
			.argument("<claim>", "Claim key")
			.requiredOption("--value <text>", "Claim value")
			.option("--kind <kind>", "attribute or constraint"),
	).action(async (entityName: string, aspect: string, group: string, claimKey: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"set_claim_value",
			{
				entity: entityName,
				aspect,
				group_key: group,
				claim_key: claimKey,
				value: options.value,
				kind: options.kind,
			},
			options,
		);
		printOperationResult(data, options, "claim set");
	});
	addCommonOptions(
		claim
			.command("versions")
			.description("List versions for a claim")
			.argument("<entity>", "Entity selector")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key")
			.argument("<claim>", "Claim key")
			.option("--kind <kind>", "attribute or constraint"),
	).action(async (entityName: string, aspect: string, group: string, claimKey: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity: entityName, aspect, group, claim: claimKey });
		appendAgent(params, options.agent);
		if (options.kind) params.set("kind", options.kind);
		const data = await apiGet(deps, "/api/ontology/claims/versions", params);
		console.log(JSON.stringify(data, null, 2));
	});
	addCommonOptions(
		claim
			.command("show")
			.description("Show one claim version")
			.argument("<entity>", "Entity selector")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key")
			.argument("<claim>", "Claim key")
			.requiredOption("--version <n>", "Version number", Number.parseInt)
			.option("--kind <kind>", "attribute or constraint"),
	).action(async (entityName: string, aspect: string, group: string, claimKey: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({
			entity: entityName,
			aspect,
			group,
			claim: claimKey,
			version: String(options.version),
		});
		appendAgent(params, options.agent);
		if (options.kind) params.set("kind", options.kind);
		const data = await apiGet(deps, "/api/ontology/claims/version", params);
		console.log(JSON.stringify(data, null, 2));
	});
	addOperationOptions(
		claim.command("archive").description("Archive a claim value").requiredOption("--attribute-id <id>"),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"archive_claim_value",
			{ attribute_id: options.attributeId, reason: options.reason },
			options,
		);
		printOperationResult(data, options, "claim archive");
	});
	addOperationOptions(
		claim.command("restore").description("Restore a claim version").requiredOption("--attribute-id <id>"),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(deps, "restore_claim_version", { attribute_id: options.attributeId }, options);
		printOperationResult(data, options, "claim restore");
	});

	const aspect = ontology.command("aspect").description("Apply audited aspect operations");
	addOperationOptions(
		aspect
			.command("create")
			.description("Create an aspect")
			.argument("<entity>", "Entity selector")
			.argument("<name>", "Aspect name"),
	).action(async (entityName: string, name: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(deps, "create_aspect", { entity: entityName, name }, options);
		printOperationResult(data, options, "aspect create");
	});
	addOperationOptions(
		aspect
			.command("rename")
			.description("Rename an aspect")
			.argument("<entity>", "Entity selector")
			.argument("<selector>", "Aspect selector")
			.argument("<new-name>", "New aspect name"),
	).action(async (entityName: string, selector: string, newName: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"rename_aspect",
			{ entity: entityName, selector, new_name: newName },
			options,
		);
		printOperationResult(data, options, "aspect rename");
	});
	addOperationOptions(
		aspect
			.command("archive")
			.description("Archive an aspect")
			.argument("<entity>", "Entity selector")
			.argument("<selector>", "Aspect selector"),
	).action(async (entityName: string, selector: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"archive_aspect",
			{ entity: entityName, selector, reason: options.reason },
			options,
		);
		printOperationResult(data, options, "aspect archive");
	});

	const link = ontology.command("link").description("Apply audited link operations");
	addOperationOptions(
		link
			.command("create")
			.description("Create a link")
			.argument("<source>", "Source entity selector")
			.argument("<type>", "Dependency/link type")
			.argument("<target>", "Target entity selector")
			.option("--source-type <type>")
			.option("--target-type <type>")
			.option("--strength <n>", "Strength from 0 to 1", Number.parseFloat)
			.option("--confidence <n>", "Confidence from 0 to 1", Number.parseFloat),
	).action(async (source: string, type: string, target: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"create_link",
			{
				source_entity: source,
				link_type: type,
				target_entity: target,
				source_type: options.sourceType,
				target_type: options.targetType,
				strength: options.strength,
				confidence: options.confidence,
				reason: options.reason,
			},
			options,
		);
		printOperationResult(data, options, "link create");
	});
	addOperationOptions(
		link
			.command("update")
			.description("Update a link")
			.argument("<id>", "Link id")
			.option("--type <type>", "Dependency/link type")
			.option("--strength <n>", "Strength from 0 to 1", Number.parseFloat)
			.option("--confidence <n>", "Confidence from 0 to 1", Number.parseFloat),
	).action(async (id: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const data = await postOperation(
			deps,
			"update_link",
			{
				id,
				link_type: options.type,
				strength: options.strength,
				confidence: options.confidence,
				reason: options.reason,
			},
			options,
		);
		printOperationResult(data, options, "link update");
	});
	addOperationOptions(link.command("archive").description("Archive a link").argument("<id>", "Link id")).action(
		async (id: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await postOperation(deps, "archive_link", { id, reason: options.reason }, options);
			printOperationResult(data, options, "link archive");
		},
	);

	const stream = ontology.command("stream").description("Apply JSONL operation streams");
	stream
		.command("apply")
		.description("Apply, dry-run, or propose a JSONL operation stream")
		.argument("<path>", "JSONL path or - for stdin")
		.option("--dry-run", "Validate and preview without writing")
		.option("--propose", "Create pending proposals for large refactor review instead of applying")
		.option("--agent <name>", "Agent scope, default default")
		.option("--actor <name>", "Audit actor", "operator")
		.option("--json", "Output as JSON")
		.action(async (path: string, options) => {
			if (options.dryRun && options.propose) {
				console.error(chalk.red("--dry-run and --propose cannot be used together"));
				process.exit(1);
			}
			if (!(await deps.ensureDaemonForSecrets())) return;
			const operations = readOperationJsonl(path);
			const data = await apiPost(deps, "/api/ontology/operations/batch", {
				agent_id: options.agent,
				actor: options.actor,
				dry_run: options.dryRun === true,
				propose: options.propose === true,
				operations,
			});
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printOperationResult(data, options, "operation stream");
		});

	const pipeline = ontology.command("pipeline").description("Inspect Pipeline V2 graph mutation state");
	pipeline
		.command("status")
		.description("Show graph-related Pipeline V2 status")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const status = asRecord(await apiGet(deps, "/api/status", new URLSearchParams()));
			const pipe = asRecord(status.pipelineV2);
			const data = {
				enabled: pipe.enabled,
				paused: pipe.paused,
				graphEnabled: asRecord(pipe.graph).enabled,
				traversal: pipe.traversal,
				shadowMode: pipe.shadowMode,
				mutationsFrozen: pipe.mutationsFrozen,
				autonomousEnabled: asRecord(pipe.autonomous).enabled,
				allowUpdateDelete: asRecord(pipe.autonomous).allowUpdateDelete,
				extraction: pipe.extraction,
				dampening: pipe.dampening,
				writeGates: {
					shadowMode: pipe.shadowMode,
					mutationsFrozen: pipe.mutationsFrozen,
					minFactConfidenceForWrite: pipe.minFactConfidenceForWrite,
					allowUpdateDelete: asRecord(pipe.autonomous).allowUpdateDelete,
				},
			};
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else {
				console.log(chalk.bold("\n  Ontology Pipeline Status\n"));
				console.log(chalk.dim(`  Pipeline V2: ${data.enabled ? "enabled" : "disabled"}`));
				console.log(chalk.dim(`  Graph:       ${data.graphEnabled ? "enabled" : "disabled"}`));
				console.log(chalk.dim(`  Traversal:   ${asRecord(data.traversal).enabled ? "enabled" : "disabled"}`));
				console.log(chalk.dim(`  Shadow:      ${data.shadowMode ? "on" : "off"}`));
				console.log(chalk.dim(`  Frozen:      ${data.mutationsFrozen ? "yes" : "no"}`));
				console.log(chalk.dim(`  Autonomous:  ${data.autonomousEnabled ? "enabled" : "disabled"}`));
				console.log(chalk.dim(`  Update/del:  ${data.allowUpdateDelete ? "allowed" : "blocked"}`));
				console.log();
			}
		});
	pipeline
		.command("config")
		.description("Show graph-related Pipeline V2 config")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const status = asRecord(await apiGet(deps, "/api/status", new URLSearchParams()));
			const pipe = asRecord(status.pipelineV2);
			const data = {
				pipelineV2: {
					enabled: pipe.enabled,
					paused: pipe.paused,
					graph: pipe.graph,
					traversal: pipe.traversal,
					reranker: pipe.reranker,
					dampening: pipe.dampening,
					shadowMode: pipe.shadowMode,
					mutationsFrozen: pipe.mutationsFrozen,
					autonomous: pipe.autonomous,
					extraction: pipe.extraction,
					hints: pipe.hints,
				},
			};
			console.log(JSON.stringify(data, null, 2));
		});
	pipeline
		.command("explain")
		.description("Explain what can currently mutate or shape the graph")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const status = asRecord(await apiGet(deps, "/api/status", new URLSearchParams()));
			const pipe = asRecord(status.pipelineV2);
			const graph = asRecord(pipe.graph);
			const autonomous = asRecord(pipe.autonomous);
			const data = {
				directOperations:
					"signet ontology entity/claim/aspect/link/stream commands apply first through audited operation handlers with provenance.",
				generatedChanges:
					"dreaming and ordinary graph maintenance should apply high-confidence operations with evidence; use pending proposals only for large refactors or explicit review.",
				pipelineWrites:
					pipe.enabled === true && pipe.shadowMode !== true && pipe.mutationsFrozen !== true
						? "Pipeline V2 controlled writes may add memories; graph extraction writes depend on graph config."
						: "Pipeline V2 direct writes are blocked by disabled, shadow, or frozen mode.",
				graphExtractionWrites: graph.extractionWritesEnabled,
				traversalShapesRecall: asRecord(pipe.traversal).enabled === true,
				autonomousMaintenance: autonomous.enabled === true && autonomous.frozen !== true,
				allowUpdateDelete: autonomous.allowUpdateDelete === true,
			};
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else {
				console.log(chalk.bold("\n  What Can Shape The Knowledge Graph\n"));
				for (const [key, value] of Object.entries(data)) console.log(`  ${chalk.dim(`${key}:`)} ${value}`);
				console.log();
			}
		});

	const config = ontology.command("config").description("Inspect ontology control-plane config");
	config
		.command("show")
		.option("--json", "Output as JSON")
		.action(async () => {
			const data = {
				operationsUsable: true,
				operationSurface: {
					applyFirst: true,
					propose: true,
					dryRun: true,
					refactorProposals: true,
					provenanceRequired: true,
					auditedThrough: "ontology_proposals",
					auditLedger: "ontology_proposals.applied",
				},
				policyFile: {
					path: "$SIGNET_WORKSPACE/ontology/graph.yaml",
					active: false,
					note: "No separate graph.yaml policy gate is active; audited daemon operation tools are usable without it.",
				},
			};
			console.log(JSON.stringify(data, null, 2));
		});
	config
		.command("validate")
		.option("--json", "Output as JSON")
		.action(async () => {
			const data = {
				valid: true,
				operationsUsable: true,
				policyFileActive: false,
				warnings: ["No external ontology graph.yaml policy gate is active."],
			};
			console.log(JSON.stringify(data, null, 2));
		});
	config
		.command("explain")
		.option("--json", "Output as JSON")
		.action(async () => {
			const data = {
				hiddenMutationPaths: false,
				explanation:
					"Dreaming and normal graph maintenance apply first through audited daemon operation endpoints with provenance; pending proposals are reserved for large graph refactors or explicit review.",
			};
			console.log(JSON.stringify(data, null, 2));
		});

	ontology
		.command("repair")
		.description("Find ontology repair candidates and optionally write large-refactor proposals")
		.option("--duplicates", "Detect duplicate entities with the same canonical name")
		.option("--orphans", "Reserved for orphan repair candidates")
		.option("--dry-run", "Preview repair candidates without writing them")
		.option("--write-proposals", "Write pending repair proposals for broad graph refactors")
		.option("-l, --limit <n>", "Max repair candidates to return", Number.parseInt)
		.option("--agent <name>", "Agent scope, default default")
		.option("--created-by <name>", "Audit creator", "ontology-repair")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (options.writeProposals && options.dryRun) {
				console.error(chalk.red("--dry-run and --write-proposals cannot be used together"));
				process.exit(1);
			}
			if (!options.duplicates) {
				console.error(chalk.red("Only --duplicates repair is implemented in this slice"));
				process.exit(1);
			}
			if (options.orphans && !options.json) {
				console.log(chalk.dim("  --orphans is reserved; only duplicate repair will run"));
			}
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await apiPost(deps, "/api/ontology/proposals/repair/duplicates", {
				agent_id: options.agent,
				created_by: options.createdBy,
				limit: options.limit,
				write_proposals: options.writeProposals === true,
			});
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printDuplicateRepairs(data);
		});

	ontology
		.command("propose")
		.description("Create a pending ontology proposal from a JSON payload")
		.requiredOption("--operation <operation>", "Proposal operation")
		.requiredOption("--payload-file <path>", "JSON object payload file")
		.option("--evidence-file <path>", "JSON evidence file, array or single object")
		.option("--confidence <n>", "Confidence from 0 to 1", Number.parseFloat)
		.option("--rationale <text>", "Short rationale")
		.option("--risk <risk>", "Risk label")
		.option("--source-kind <kind>", "Evidence source kind")
		.option("--source-id <id>", "Evidence source id")
		.option("--source-path <path>", "Evidence source path")
		.option("--source-root <path>", "Evidence source root")
		.option("--agent <name>", "Agent scope, default default")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const body = {
				agent_id: options.agent,
				operation: options.operation,
				payload: readPayloadFile(options.payloadFile),
				evidence: readEvidenceFile(options.evidenceFile),
				confidence: options.confidence,
				rationale: options.rationale,
				risk: options.risk,
				source_kind: options.sourceKind,
				source_id: options.sourceId,
				source_path: options.sourcePath,
				source_root: options.sourceRoot,
			};
			const data = await apiPost(deps, "/api/ontology/proposals", body);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`Created ontology proposal ${asRecord(data).id ?? ""}`));
		});

	ontology
		.command("import-proposals")
		.description("Import pending ontology proposals from proposal or extraction JSON")
		.requiredOption("--file <path>", "JSON proposal array, { proposals }, or extraction output")
		.option("--agent <name>", "Agent scope, default default")
		.option("--created-by <name>", "Audit creator", "operator")
		.option("--source-kind <kind>", "Default evidence source kind")
		.option("--source-id <id>", "Default evidence source id")
		.option("--source-path <path>", "Default evidence source path")
		.option("--source-root <path>", "Default evidence source root")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const proposals = readProposalFile(options.file);
			if (proposals.length === 0) {
				console.error(chalk.red("No importable ontology proposals found"));
				process.exit(1);
			}
			const body = {
				agent_id: options.agent,
				created_by: options.createdBy,
				source_kind: options.sourceKind,
				source_id: options.sourceId,
				source_path: options.sourcePath,
				source_root: options.sourceRoot,
				proposals,
			};
			const data = await apiPost(deps, "/api/ontology/proposals/batch", body);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`Imported ${asRecord(data).count ?? proposals.length} ontology proposals`));
		});

	ontology
		.command("apply")
		.description("Apply a pending ontology proposal")
		.argument("<id>", "Proposal id")
		.option("--agent <name>", "Agent scope, default default")
		.option("--actor <name>", "Audit actor", "operator")
		.option("--json", "Output as JSON")
		.action(async (id: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const params = new URLSearchParams();
			appendAgent(params, options.agent);
			const query = params.toString();
			const data = await apiPost(
				deps,
				`/api/ontology/proposals/${encodeURIComponent(id)}/apply${query ? `?${query}` : ""}`,
				{ actor: options.actor },
			);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`Applied ontology proposal ${asRecord(data).id ?? id}`));
		});

	ontology
		.command("reject")
		.description("Reject a pending ontology proposal")
		.argument("<id>", "Proposal id")
		.option("--reason <text>", "Rejection reason")
		.option("--agent <name>", "Agent scope, default default")
		.option("--actor <name>", "Audit actor", "operator")
		.option("--json", "Output as JSON")
		.action(async (id: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const params = new URLSearchParams();
			appendAgent(params, options.agent);
			const query = params.toString();
			const data = await apiPost(
				deps,
				`/api/ontology/proposals/${encodeURIComponent(id)}/reject${query ? `?${query}` : ""}`,
				{ actor: options.actor, reason: options.reason },
			);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`Rejected ontology proposal ${asRecord(data).id ?? id}`));
		});
}
