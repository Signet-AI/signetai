import chalk from "chalk";
import type { Command } from "commander";

interface KnowledgeDeps {
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

interface EntityRecord {
	readonly name?: string;
	readonly entityType?: string;
	readonly canonicalName?: string;
}

interface CountedEntity {
	readonly entity?: EntityRecord;
	readonly aspectCount?: number;
	readonly attributeCount?: number;
	readonly constraintCount?: number;
	readonly dependencyCount?: number;
}

interface AspectRecord {
	readonly name?: string;
	readonly canonicalName?: string;
}

interface TreeClaim {
	readonly claimKey?: string;
	readonly activeCount?: number;
	readonly supersededCount?: number;
	readonly preview?: string | null;
}

interface TreeGroup {
	readonly groupKey?: string;
	readonly attributeCount?: number;
	readonly constraintCount?: number;
	readonly claimCount?: number;
	readonly claims?: readonly TreeClaim[];
}

interface TreeAspect {
	readonly aspect?: AspectRecord;
	readonly attributeCount?: number;
	readonly constraintCount?: number;
	readonly groupCount?: number;
	readonly claimCount?: number;
	readonly groups?: readonly TreeGroup[];
}

interface TreeResponse {
	readonly entity?: EntityRecord;
	readonly items?: readonly TreeAspect[];
}

interface AttributeRecord {
	readonly content?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly confidence?: number;
	readonly updatedAt?: string;
}

interface SuspiciousEntityRecord {
	readonly name?: string;
	readonly reason?: string;
	readonly mentions?: number;
}

interface DuplicateEntityRecord {
	readonly canonicalName?: string;
	readonly count?: number;
	readonly names?: readonly string[];
}

interface AttributeHygieneRecord {
	readonly missingGroupKey?: number;
	readonly missingClaimKey?: number;
	readonly missingSourceMemory?: number;
}

interface SafeMentionCandidateRecord {
	readonly entityName?: string;
	readonly memoryId?: string;
	readonly snippet?: string;
}

interface HygieneResponse {
	readonly suspiciousEntities?: readonly SuspiciousEntityRecord[];
	readonly duplicateEntities?: readonly DuplicateEntityRecord[];
	readonly attributeSummary?: AttributeHygieneRecord;
	readonly safeMentionCandidates?: readonly SafeMentionCandidateRecord[];
}

interface ListResponse<T> {
	readonly items?: readonly T[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function errorMessage(data: unknown, fallback: string): string {
	const raw = asRecord(data).error;
	return typeof raw === "string" ? raw : fallback;
}

function addCommonOptions(cmd: Command): Command {
	return cmd.option("--agent <name>", "Agent scope, default default").option("--json", "Output as JSON");
}

function appendAgent(params: URLSearchParams, agent?: string): void {
	if (agent) params.set("agent_id", agent);
}

async function apiGet(deps: KnowledgeDeps, path: string, params: URLSearchParams): Promise<unknown> {
	const query = params.toString();
	const { ok, data } = await deps.secretApiCall("GET", query ? `${path}?${query}` : path, undefined, 10_000);
	if (!ok || typeof asRecord(data).error === "string") {
		console.error(chalk.red(errorMessage(data, "Knowledge request failed")));
		process.exit(1);
	}
	return data;
}

function entityName(entity: EntityRecord | undefined): string {
	return entity?.name ?? entity?.canonicalName ?? "unknown";
}

function countLabel(value: number | undefined, noun: string): string {
	const n = value ?? 0;
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function printEntityList(data: unknown): void {
	const items = (asRecord(data).items as readonly CountedEntity[] | undefined) ?? [];
	if (items.length === 0) {
		console.log(chalk.dim("  No entities found"));
		return;
	}
	console.log(chalk.bold("\n  Knowledge Entities\n"));
	for (const item of items) {
		const type = item.entity?.entityType ? chalk.dim(` (${item.entity.entityType})`) : "";
		console.log(`  ${chalk.cyan(entityName(item.entity))}${type}`);
		console.log(
			chalk.dim(
				`    ${countLabel(item.aspectCount, "aspect")} · ${countLabel(item.attributeCount, "attribute")} · ${countLabel(
					item.constraintCount,
					"constraint",
				)} · ${countLabel(item.dependencyCount, "dependency")}`,
			),
		);
	}
	console.log();
}

function printTree(data: unknown): void {
	const tree = data as TreeResponse;
	console.log(chalk.bold(`\n  Knowledge Tree: ${chalk.cyan(entityName(tree.entity))}\n`));
	for (const item of tree.items ?? []) {
		const aspect = item.aspect?.name ?? item.aspect?.canonicalName ?? "unknown";
		console.log(
			`  ${chalk.cyan(aspect)} ${chalk.dim(
				`${countLabel(item.attributeCount, "attribute")} · ${countLabel(item.constraintCount, "constraint")} · ${countLabel(
					item.groupCount,
					"group",
				)} · ${countLabel(item.claimCount, "claim")}`,
			)}`,
		);
		for (const group of item.groups ?? []) {
			console.log(
				`    ${chalk.yellow(group.groupKey ?? "general")} ${chalk.dim(
					`${countLabel(group.attributeCount, "attribute")} · ${countLabel(group.constraintCount, "constraint")} · ${countLabel(
						group.claimCount,
						"claim",
					)}`,
				)}`,
			);
			for (const claim of group.claims ?? []) {
				const history = claim.supersededCount && claim.supersededCount > 0 ? ` · ${claim.supersededCount} old` : "";
				console.log(`      ${claim.claimKey ?? "unknown"} ${chalk.dim(`${claim.activeCount ?? 0} active${history}`)}`);
				if (claim.preview) console.log(chalk.dim(`        ${claim.preview}`));
			}
		}
	}
	console.log();
}

function printNamedItems<T>(
	data: unknown,
	title: string,
	getName: (item: T) => string,
	getSummary?: (item: T) => string,
): void {
	const items = ((asRecord(data) as ListResponse<T>).items ?? []) as readonly T[];
	if (items.length === 0) {
		console.log(chalk.dim(`  No ${title.toLowerCase()} found`));
		return;
	}
	console.log(chalk.bold(`\n  ${title}\n`));
	for (const item of items) {
		console.log(`  ${chalk.cyan(getName(item))}`);
		const summary = getSummary?.(item);
		if (summary) console.log(chalk.dim(`    ${summary}`));
	}
	console.log();
}

function printAttributes(data: unknown): void {
	const items = ((asRecord(data) as ListResponse<AttributeRecord>).items ?? []) as readonly AttributeRecord[];
	if (items.length === 0) {
		console.log(chalk.dim("  No attributes found"));
		return;
	}
	console.log(chalk.bold("\n  Knowledge Attributes\n"));
	for (const item of items) {
		console.log(`  ${item.content ?? ""}`);
		const parts = [item.kind, item.status, item.updatedAt].filter((part): part is string => typeof part === "string");
		if (typeof item.confidence === "number") parts.push(`confidence ${item.confidence.toFixed(2)}`);
		if (parts.length > 0) console.log(chalk.dim(`    ${parts.join(" · ")}`));
	}
	console.log();
}

function printHygieneReport(data: unknown): void {
	const report = data as HygieneResponse;
	const suspicious = report.suspiciousEntities ?? [];
	const duplicates = report.duplicateEntities ?? [];
	const summary = report.attributeSummary ?? {};
	const candidates = report.safeMentionCandidates ?? [];

	console.log(chalk.bold("\n  Knowledge Hygiene Report\n"));
	console.log(
		chalk.dim(
			`  attributes: ${summary.missingGroupKey ?? 0} missing groups · ${summary.missingClaimKey ?? 0} missing claims · ${
				summary.missingSourceMemory ?? 0
			} missing sources`,
		),
	);

	if (suspicious.length > 0) {
		console.log(chalk.bold("\n  Suspicious entities"));
		for (const entity of suspicious.slice(0, 10)) {
			console.log(`  ${chalk.cyan(entity.name ?? "unknown")} ${chalk.dim(entity.reason ?? "unknown")}`);
		}
	}

	if (duplicates.length > 0) {
		console.log(chalk.bold("\n  Duplicate canonical groups"));
		for (const group of duplicates.slice(0, 10)) {
			console.log(`  ${chalk.cyan(group.canonicalName ?? "unknown")} ${chalk.dim(`${group.count ?? 0} entities`)}`);
			if (group.names && group.names.length > 0) console.log(chalk.dim(`    ${group.names.join(", ")}`));
		}
	}

	if (candidates.length > 0) {
		console.log(chalk.bold("\n  Safe mention candidates"));
		for (const candidate of candidates.slice(0, 10)) {
			console.log(`  ${chalk.cyan(candidate.entityName ?? "unknown")} ${chalk.dim(candidate.memoryId ?? "")}`);
			if (candidate.snippet) console.log(chalk.dim(`    ${candidate.snippet}`));
		}
	}

	if (suspicious.length === 0 && duplicates.length === 0 && candidates.length === 0) {
		console.log(chalk.dim("\n  No obvious hygiene issues found"));
	}
	console.log();
}

export function registerKnowledgeCommands(program: Command, deps: KnowledgeDeps): void {
	const knowledge = program.command("knowledge").description("Browse the structured knowledge graph");

	addCommonOptions(
		knowledge
			.command("tree")
			.description("Show a compact entity -> aspect -> group -> claim outline")
			.argument("[entity]", "Entity name. Omit to list entities first.")
			.option("--depth <n>", "Depth: 1=aspects, 2=groups, 3=claims", Number.parseInt)
			.option("--max-aspects <n>", "Max aspects to return", Number.parseInt)
			.option("--max-groups <n>", "Max groups per aspect", Number.parseInt)
			.option("--max-claims <n>", "Max claims per group", Number.parseInt),
	).action(async (entity: string | undefined, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		if (!entity) {
			if (options.maxAspects !== undefined) params.set("limit", String(options.maxAspects));
			appendAgent(params, options.agent);
			const data = await apiGet(deps, "/api/knowledge/navigation/entities", params);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printEntityList(data);
			return;
		}
		params.set("entity", entity);
		if (options.depth !== undefined) params.set("depth", String(options.depth));
		if (options.maxAspects !== undefined) params.set("max_aspects", String(options.maxAspects));
		if (options.maxGroups !== undefined) params.set("max_groups", String(options.maxGroups));
		if (options.maxClaims !== undefined) params.set("max_claims", String(options.maxClaims));
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/tree", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printTree(data);
	});

	addCommonOptions(
		knowledge
			.command("entities")
			.description("List top-level knowledge graph entities")
			.option("-q, --query <query>", "Optional entity name filter")
			.option("--type <type>", "Optional entity type filter")
			.option("-l, --limit <n>", "Max entities to return", Number.parseInt)
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
		else printEntityList(data);
	});

	addCommonOptions(
		knowledge.command("entity").description("Resolve one entity by name").argument("<name>", "Entity name"),
	).action(async (name: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ name });
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/entity", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else console.log(JSON.stringify(data, null, 2));
	});

	addCommonOptions(
		knowledge.command("aspects").description("List aspects under an entity").argument("<entity>", "Entity name"),
	).action(async (entity: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity });
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/aspects", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else {
			printNamedItems<{ aspect?: AspectRecord; attributeCount?: number; constraintCount?: number }>(
				data,
				"Knowledge Aspects",
				(item) => item.aspect?.name ?? item.aspect?.canonicalName ?? "unknown",
				(item) => `${countLabel(item.attributeCount, "attribute")} · ${countLabel(item.constraintCount, "constraint")}`,
			);
		}
	});

	addCommonOptions(
		knowledge
			.command("groups")
			.description("List groups under an entity aspect")
			.argument("<entity>", "Entity name")
			.argument("<aspect>", "Aspect name"),
	).action(async (entity: string, aspect: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity, aspect });
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/groups", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else {
			printNamedItems<{ groupKey?: string; attributeCount?: number; constraintCount?: number; claimCount?: number }>(
				data,
				"Knowledge Groups",
				(item) => item.groupKey ?? "general",
				(item) =>
					`${countLabel(item.attributeCount, "attribute")} · ${countLabel(item.constraintCount, "constraint")} · ${countLabel(
						item.claimCount,
						"claim",
					)}`,
			);
		}
	});

	addCommonOptions(
		knowledge
			.command("claims")
			.description("List claim slots under an entity/aspect/group path")
			.argument("<entity>", "Entity name")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key"),
	).action(async (entity: string, aspect: string, group: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity, aspect, group });
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/claims", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else {
			printNamedItems<TreeClaim>(
				data,
				"Knowledge Claims",
				(item) => item.claimKey ?? "unknown",
				(item) => `${item.activeCount ?? 0} active · ${item.supersededCount ?? 0} old`,
			);
		}
	});

	addCommonOptions(
		knowledge
			.command("attributes")
			.description("List attributes under an entity/aspect/group/claim path")
			.argument("<entity>", "Entity name")
			.argument("<aspect>", "Aspect name")
			.argument("<group>", "Group key")
			.argument("<claim>", "Claim key")
			.option("--status <status>", "active, superseded, deleted, or all")
			.option("--kind <kind>", "attribute or constraint")
			.option("-l, --limit <n>", "Max attributes to return", Number.parseInt)
			.option("--offset <n>", "Pagination offset", Number.parseInt),
	).action(async (entity: string, aspect: string, group: string, claim: string, options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams({ entity, aspect, group, claim });
		if (options.status) params.set("status", options.status);
		if (options.kind) params.set("kind", options.kind);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.offset !== undefined) params.set("offset", String(options.offset));
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/navigation/attributes", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printAttributes(data);
	});

	addCommonOptions(
		knowledge
			.command("hygiene")
			.description("Run a report-only graph hygiene scan")
			.option("-l, --limit <n>", "Max rows per report section", Number.parseInt)
			.option("--memory-limit <n>", "Recent memories to scan for safe mention candidates", Number.parseInt),
	).action(async (options) => {
		if (!(await deps.ensureDaemonForSecrets())) return;
		const params = new URLSearchParams();
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.memoryLimit !== undefined) params.set("memory_limit", String(options.memoryLimit));
		appendAgent(params, options.agent);
		const data = await apiGet(deps, "/api/knowledge/hygiene", params);
		if (options.json) console.log(JSON.stringify(data, null, 2));
		else printHygieneReport(data);
	});
}
