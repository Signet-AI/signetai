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
	readonly mentions?: number;
}

interface RepairDuplicateItem {
	readonly canonicalName?: string;
	readonly target?: RepairDuplicateEntity;
	readonly sources?: readonly RepairDuplicateEntity[];
	readonly rationale?: string;
}

interface RepairDuplicatesResponse {
	readonly items?: readonly RepairDuplicateItem[];
	readonly writtenCount?: number;
	readonly dryRun?: boolean;
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
	readonly count?: number;
	readonly writtenCount?: number;
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
	if (items.length === 0) {
		console.log(chalk.dim("  No duplicate entity merge candidates found"));
		return;
	}

	const mode = record.dryRun === false ? "Duplicate Merge Proposals" : "Duplicate Merge Candidates";
	console.log(chalk.bold(`\n  ${mode}\n`));
	for (const item of items) {
		const target = item.target?.name ?? "unknown";
		const sources = (item.sources ?? []).map((source) => source.name ?? source.id ?? "unknown").join(", ");
		console.log(`  ${chalk.yellow(item.canonicalName ?? "unknown")} ${chalk.cyan(target)} <- ${sources}`);
		if (item.rationale) console.log(chalk.dim(`    ${item.rationale}`));
	}
	if (writtenCount > 0) console.log(chalk.green(`\n  Created ${writtenCount} pending merge proposals`));
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

	ontology
		.command("extract")
		.description("Extract candidate ontology proposals from a transcript or artifact")
		.requiredOption("--from <source>", "Source ref, e.g. transcript:<id>, artifact:<path>, or source:<path>")
		.option("--write-proposals", "Persist extracted candidates as pending proposals")
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
		.option("--write-proposals", "Persist consolidated candidates as pending proposals")
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

	ontology
		.command("repair")
		.description("Find ontology repair candidates and optionally write proposals")
		.option("--duplicates", "Detect duplicate entities with the same canonical name")
		.option("--orphans", "Reserved for orphan repair candidates")
		.option("--dry-run", "Preview repair proposals without writing them")
		.option("--write-proposals", "Write pending repair proposals")
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
