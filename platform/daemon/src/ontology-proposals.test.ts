import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { getOntologyClaimEvidence } from "./ontology-claim-evidence";
import { consolidateOntologyProposals } from "./ontology-consolidation";
import { extractOntologyProposals } from "./ontology-extraction";
import { getOntologyLinkEvidence } from "./ontology-link-evidence";
import {
	OntologyProposalError,
	applyOntologyOperation,
	applyOntologyOperationBatch,
	applyOntologyProposal,
	createEntityMergePlan,
	createOntologyProposal,
	createOntologyProposals,
	getClaimVersion,
	getOntologyProposal,
	getOntologyProposalEvidence,
	listClaimVersions,
	listOntologyProposalConflicts,
	listOntologyProposals,
	proposeDuplicateEntityMerges,
	rejectOntologyProposal,
} from "./ontology-proposals";

describe("ontology proposals", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ontology-proposals-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(
		id: string,
		name: string,
		canonicalName: string,
		agentId: string,
		mentions: number,
		pinned = false,
		entityType = "project",
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				canonicalName,
				entityType,
				agentId,
				mentions,
				pinned ? 1 : 0,
				"2026-05-06T00:00:00.000Z",
				`2026-05-06T00:0${mentions}:00.000Z`,
			);
		});
	}

	it("applies an add_claim_value proposal into a grouped claim slot with provenance", () => {
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Ontology extraction writes proposals before mutating semantic state.",
			},
			confidence: 0.92,
			rationale: "Explicit architecture decision from transcript evidence.",
			evidence: [{ source: "transcript:test", message_ids: ["m1"] }],
			sourceKind: "transcript",
			sourceId: "transcript:test",
			sourcePath: "memory/test-transcript.jsonl",
			createdBy: "test",
		});

		expect(proposal.status).toBe("pending");

		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: proposal.id,
			actor: "ant",
		});

		expect(applied.status).toBe("applied");
		expect(applied.appliedBy).toBe("ant");
		expect(typeof applied.result?.attributeId).toBe("string");

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.agent_id, e.entity_type, asp.name AS aspect, attr.group_key,
							        attr.claim_key, attr.content, attr.confidence, attr.source_kind,
							        attr.proposal_id, attr.proposal_evidence
							 FROM entity_attributes attr
							 JOIN entity_aspects asp ON asp.id = attr.aspect_id
							 JOIN entities e ON e.id = asp.entity_id
						 WHERE e.name = ? AND e.agent_id = ?`,
					)
					.get("Signet", "ant") as
					| {
							agent_id: string;
							entity_type: string;
							aspect: string;
							group_key: string;
							claim_key: string;
							content: string;
							confidence: number;
							source_kind: string;
							proposal_id: string;
							proposal_evidence: string;
					  }
					| undefined,
		);

		expect(row?.agent_id).toBe("ant");
		expect(row?.entity_type).toBe("project");
		expect(row?.aspect).toBe("architecture");
		expect(row?.group_key).toBe("ontology");
		expect(row?.claim_key).toBe("proposal_loop");
		expect(row?.content).toContain("writes proposals");
		expect(row?.confidence).toBeCloseTo(0.92);
		expect(row?.source_kind).toBe("transcript");
		expect(row?.proposal_id).toBe(proposal.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([{ source: "transcript:test", message_ids: ["m1"] }]);
	});

	it("rejects a pending proposal without mutating graph state", () => {
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Temporary Entity", entity_type: "concept" },
			rationale: "Low confidence extraction.",
		});

		const rejected = rejectOntologyProposal(getDbAccessor(), {
			agentId: "default",
			id: proposal.id,
			actor: "operator",
			reason: "weak evidence",
		});

		expect(rejected.status).toBe("rejected");
		expect(rejected.result?.reason).toBe("weak evidence");

		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE name = ?").get("Temporary Entity") as { id: string } | undefined,
		);
		expect(entity).toBeNull();
	});

	it("rejects empty proposal operations before storage", () => {
		expect(() =>
			createOntologyProposal(getDbAccessor(), {
				agentId: "default",
				operation: "   ",
				payload: { name: "Missing Operation" },
			}),
		).toThrow(OntologyProposalError);
	});

	it("creates proposal batches atomically in one agent scope", () => {
		const batch = createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "create_entity",
				payload: { name: "Transcript Artifact", entity_type: "source" },
				sourceKind: "transcript",
				sourceId: "transcript:1",
				createdBy: "importer",
			},
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					claim_key: "maintenance_loop",
					value: "Extraction emits proposals before ontology mutation.",
				},
				evidence: [{ transcript_id: "transcript:1", message_ids: ["m1"] }],
				confidence: 0.8,
				sourceKind: "transcript",
				sourceId: "transcript:1",
				createdBy: "importer",
			},
		]);

		expect(batch.count).toBe(2);
		expect(batch.items.map((item) => item.status)).toEqual(["pending", "pending"]);
		expect(batch.items.every((item) => item.agentId === "ant")).toBe(true);
		expect(batch.items[1]?.evidence).toHaveLength(1);

		const listed = listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "add_claim_value" });
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0]?.createdBy).toBe("importer");
		expect(listed.items[0]?.sourceKind).toBe("transcript");
	});

	it("extracts candidate proposals from explicit transcript extraction JSON", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:extract",
				JSON.stringify({
					claim_values: [
						{
							entity: "Signet",
							aspect: "architecture",
							group_key: "ontology",
							claim_key: "proposal_loop",
							value: "Extraction emits pending proposals.",
							confidence: 0.91,
							evidence: [{ transcript_id: "transcript:extract", quote: "Extraction emits pending proposals." }],
						},
					],
					links: [
						{
							source_entity: "Transcript artifact",
							link_type: "supports_claim",
							target_entity: "Signet",
							reason: "The transcript explicitly supports the claim.",
						},
					],
				}),
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const dryRun = await extractOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			from: "transcript:extract",
		});

		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.count).toBe(2);
		expect(dryRun.writtenCount).toBe(0);
		expect(dryRun.proposals.map((proposal) => proposal.operation)).toEqual(["add_claim_value", "create_link"]);

		const written = await extractOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			from: "transcript:extract",
			writeProposals: true,
			createdBy: "test-extractor",
		});

		expect(written.dryRun).toBe(false);
		expect(written.writtenCount).toBe(2);
		expect(written.items.map((item) => item.createdBy)).toEqual(["test-extractor", "test-extractor"]);
		expect(written.items.every((item) => item.sourceKind === "transcript")).toBe(true);
	});

	it("mechanically extracts conservative proposals from plain transcript text", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"plain-extract",
				"Signet should become an agent-first ontology. [[Hermes Agent]] is relevant. Hermes Agent supports Signet proposal loop.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const result = await extractOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			from: "transcript:plain-extract",
		});

		expect(result.proposals.some((proposal) => proposal.operation === "create_entity")).toBe(true);
		expect(result.proposals.some((proposal) => proposal.operation === "add_claim_value")).toBe(true);
		expect(result.proposals.some((proposal) => proposal.operation === "create_link")).toBe(true);
		expect(result.proposals.every((proposal) => proposal.evidence && proposal.evidence.length > 0)).toBe(true);
	});

	it("uses an inference provider for ontology extraction when requested", async () => {
		const prompts: string[] = [];
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"provider-extract",
				"User: Signet ontology extraction should route through the inference registry when explicitly requested.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const result = await extractOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			from: "transcript:provider-extract",
			useProvider: true,
			provider: {
				name: "test-provider",
				async available() {
					return true;
				},
				async generate(prompt) {
					prompts.push(prompt);
					return JSON.stringify({
						claim_values: [
							{
								entity: "Signet",
								aspect: "architecture",
								group_key: "ontology",
								claim_key: "provider_extraction",
								value: "Ontology extraction can use the configured inference workload.",
								confidence: 0.88,
								evidence: [
									{
										source_kind: "transcript",
										source_id: "provider-extract",
										quote: "route through the inference registry",
									},
								],
							},
						],
						questions: ["Should provider extraction become the default for strong-model maintenance?"],
					});
				},
			},
		});

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Return ONLY JSON");
		expect(result.extractionMode).toBe("provider");
		expect(result.providerName).toBe("test-provider");
		expect(result.warnings).toHaveLength(0);
		expect(result.questions).toEqual(["Should provider extraction become the default for strong-model maintenance?"]);
		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0]?.payload.claim_key).toBe("provider_extraction");
	});

	it("consolidates pending proposals through an inference provider without direct mutation", async () => {
		createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Extraction should emit proposals first.",
			},
			confidence: 0.72,
			rationale: "Raw extraction candidate.",
		});
		createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Ontology maintenance should review proposals before mutation.",
			},
			confidence: 0.8,
			rationale: "Second raw extraction candidate.",
		});

		const dryRun = await consolidateOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			useProvider: true,
			provider: {
				name: "test-consolidator",
				async available() {
					return true;
				},
				async generate(prompt) {
					expect(prompt).toContain("Pending proposals");
					return JSON.stringify({
						summary: "Combined two noisy proposal-loop candidates.",
						proposals: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Signet",
									aspect: "architecture",
									group_key: "ontology",
									claim_key: "proposal_loop",
									value: "Signet ontology maintenance uses proposals before mutation.",
								},
								confidence: 0.9,
								rationale: "The pending proposals agree on proposal-before-mutation semantics.",
								evidence: [{ source_kind: "ontology_proposal", source_id: "candidate", quote: "proposals first" }],
							},
						],
						rejections: [{ candidate_id: "duplicate", reason: "duplicate" }],
					});
				},
			},
		});

		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.consolidationMode).toBe("provider");
		expect(dryRun.writtenCount).toBe(0);
		expect(dryRun.proposals).toHaveLength(1);
		expect(dryRun.rejections).toHaveLength(1);

		const written = await consolidateOntologyProposals(getDbAccessor(), {
			agentId: "ant",
			useProvider: true,
			writeProposals: true,
			createdBy: "test-consolidator",
			provider: {
				name: "test-consolidator",
				async available() {
					return true;
				},
				async generate() {
					return JSON.stringify({
						proposals: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Signet",
									aspect: "architecture",
									group_key: "ontology",
									claim_key: "proposal_loop",
									value: "Signet ontology maintenance uses proposals before mutation.",
								},
							},
						],
					});
				},
			},
		});

		expect(written.dryRun).toBe(false);
		expect(written.writtenCount).toBe(1);
		expect(written.items[0]?.createdBy).toBe("test-consolidator");
		expect(written.items[0]?.sourceKind).toBe("ontology_consolidation");
	});

	it("resolves proposal evidence from transcripts and indexed artifacts", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:1",
				"User: Signet extraction should emit proposals. Assistant: The ontology only mutates after review.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/transcript.jsonl",
				"sha",
				"transcript",
				"session-1",
				"transcript:1",
				"token-1",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Canonical artifact says proposals preserve lineage back to source truth.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				claim_key: "review_loop",
				value: "Ontology proposals are reviewed before mutation.",
			},
			evidence: [
				{
					transcript_id: "transcript:1",
					quote: "ontology only mutates after review",
				},
			],
			sourceKind: "transcript",
			sourceId: "transcript:1",
			sourcePath: "memory/codex/transcripts/transcript.jsonl",
		});

		const evidence = getOntologyProposalEvidence(getDbAccessor(), proposal.id, "ant");

		expect(evidence.count).toBe(2);
		expect(evidence.items[0]?.kind).toBe("session_transcript");
		expect(evidence.items[0]?.excerpt).toContain("mutates after review");
		expect(evidence.items[1]?.kind).toBe("memory_artifact");
		expect(evidence.items[1]?.excerpt).toContain("preserve lineage");
	});

	it("resolves applied claim evidence from stored attribute provenance", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:claim",
				"User: Signet claims need evidence after proposal application.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/claim.jsonl",
				"sha-claim",
				"transcript",
				"session-claim",
				"transcript:claim",
				"token-claim",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Artifact source truth says applied claims still need auditable lineage.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "claim_evidence",
				value: "Applied ontology claims retain source-backed evidence.",
			},
			confidence: 0.88,
			sourceKind: "transcript",
			sourceId: "transcript:claim",
			sourcePath: "memory/codex/transcripts/claim.jsonl",
		});
		applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: proposal.id, actor: "ant" });

		const evidence = getOntologyClaimEvidence(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "claim_evidence",
		});

		expect(evidence.count).toBe(1);
		expect(evidence.items[0]?.attribute.sourceKind).toBe("transcript");
		expect(evidence.items[0]?.attribute.sourcePath).toBe("memory/codex/transcripts/claim.jsonl");
		expect(evidence.items[0]?.attribute.proposalId).toBe(proposal.id);
		expect(evidence.items[0]?.evidence.map((item) => item.kind)).toEqual([
			"ontology_proposal",
			"session_transcript",
			"memory_artifact",
		]);
		expect(evidence.items[0]?.evidence[0]?.label).toBe(`proposal:${proposal.id}`);
		expect(evidence.items[0]?.evidence[1]?.excerpt).toContain("evidence after proposal application");
		expect(evidence.items[0]?.evidence[2]?.excerpt).toContain("auditable lineage");
	});

	it("falls back to embedded quotes when source rows are not present", () => {
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Quoted Evidence" },
			evidence: [{ transcript_id: "missing", quote: "This quote still explains the proposal." }],
		});

		const evidence = getOntologyProposalEvidence(getDbAccessor(), proposal.id, "default");

		expect(evidence.items).toHaveLength(1);
		expect(evidence.items[0]?.kind).toBe("provided_quote");
		expect(evidence.items[0]?.excerpt).toBe("This quote still explains the proposal.");
	});

	it("applies supersede_claim_value by preserving old values and adding replacements", () => {
		const initial = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "current_loop",
				value: "Extraction writes directly into ontology state.",
			},
			confidence: 0.4,
		});
		const initialApplied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: initial.id,
			actor: "test",
		});
		const oldId = initialApplied.result?.attributeId;
		expect(typeof oldId).toBe("string");

		const supersede = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "supersede_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "current_loop",
				old_value: "Extraction writes directly into ontology state.",
				new_value: "Extraction writes pending proposals before ontology mutation.",
				confidence: 0.93,
			},
			sourceKind: "transcript",
			sourceId: "transcript:proposal-loop",
		});

		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: supersede.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		const replacementId = applied.result?.replacementAttributeId;
		expect(typeof replacementId).toBe("string");
		expect(applied.result?.supersededAttributeIds).toEqual([oldId]);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, content, status, superseded_by, confidence, source_kind
						 FROM entity_attributes
						 WHERE id IN (?, ?)
						 ORDER BY status DESC`,
					)
					.all(oldId as string, replacementId as string) as Array<{
					id: string;
					content: string;
					status: string;
					superseded_by: string | null;
					confidence: number;
					source_kind: string | null;
				}>,
		);

		const old = rows.find((row) => row.id === oldId);
		const replacement = rows.find((row) => row.id === replacementId);
		expect(old?.status).toBe("superseded");
		expect(old?.superseded_by).toBe(replacementId);
		expect(replacement?.status).toBe("active");
		expect(replacement?.content).toContain("pending proposals");
		expect(replacement?.confidence).toBeCloseTo(0.93);
		expect(replacement?.source_kind).toBe("transcript");
	});

	it("applies semantic create_link proposal roles from ontology extraction", () => {
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "create_link",
			payload: {
				source_entity: "Transcript Artifact",
				source_type: "artifact",
				link_type: "supports_claim",
				target_entity: "Signet proposal loop",
				target_type: "concept",
				reason: "Transcript evidence supports the reviewed claim.",
				confidence: 0.86,
			},
			sourceKind: "transcript",
			sourceId: "transcript:semantic-link",
		});

		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: proposal.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		expect(typeof applied.result?.dependencyId).toBe("string");
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT dep.dependency_type, dep.confidence, dep.source_kind,
							        dep.proposal_id, dep.proposal_evidence,
							        src.entity_type AS source_type, dst.entity_type AS target_type
							 FROM entity_dependencies dep
							 JOIN entities src ON src.id = dep.source_entity_id
						 JOIN entities dst ON dst.id = dep.target_entity_id
						 WHERE dep.id = ?`,
					)
					.get(applied.result?.dependencyId as string) as
					| {
							dependency_type: string;
							confidence: number;
							source_kind: string | null;
							proposal_id: string | null;
							proposal_evidence: string;
							source_type: string;
							target_type: string;
					  }
					| undefined,
		);
		expect(row?.dependency_type).toBe("supports_claim");
		expect(row?.confidence).toBeCloseTo(0.86);
		expect(row?.source_kind).toBe("transcript");
		expect(row?.proposal_id).toBe(proposal.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([]);
		expect(row?.source_type).toBe("artifact");
		expect(row?.target_type).toBe("concept");
	});

	it("resolves applied link evidence from stored dependency provenance", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:link",
				"User: Transcript Artifact supports the Signet proposal loop claim.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/link.jsonl",
				"sha-link",
				"transcript",
				"session-link",
				"transcript:link",
				"token-link",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Artifact source truth says this transcript supports the proposal-loop claim.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "create_link",
			payload: {
				source_entity: "Transcript Artifact",
				source_type: "artifact",
				link_type: "supports_claim",
				target_entity: "Signet proposal loop",
				target_type: "concept",
				reason: "Transcript supports the claim.",
			},
			sourceKind: "transcript",
			sourceId: "transcript:link",
			sourcePath: "memory/codex/transcripts/link.jsonl",
		});
		const applied = applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: proposal.id, actor: "test" });
		const dependencyId = applied.result?.dependencyId;
		expect(typeof dependencyId).toBe("string");

		const evidence = getOntologyLinkEvidence(getDbAccessor(), {
			agentId: "ant",
			id: dependencyId as string,
		});

		expect(evidence.dependency.sourceKind).toBe("transcript");
		expect(evidence.dependency.proposalId).toBe(proposal.id);
		expect(evidence.items.map((item) => item.kind)).toEqual([
			"ontology_proposal",
			"session_transcript",
			"memory_artifact",
		]);
		expect(evidence.items[0]?.label).toBe(`proposal:${proposal.id}`);
		expect(evidence.items[1]?.excerpt).toContain("supports the Signet proposal loop");
		expect(evidence.items[2]?.excerpt).toContain("supports the proposal-loop claim");
	});

	it("groups pending add_claim_value conflicts by claim slot", () => {
		createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Extraction writes directly into the graph.",
				},
				confidence: 0.4,
			},
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Extraction writes proposals before graph mutation.",
				},
				confidence: 0.93,
			},
			{
				agentId: "dot",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Different agent scope should not join conflicts.",
				},
			},
		]);

		const conflicts = listOntologyProposalConflicts(getDbAccessor(), { agentId: "ant" });
		const other = listOntologyProposalConflicts(getDbAccessor(), { agentId: "dot" });

		expect(conflicts.count).toBe(1);
		expect(conflicts.items[0]?.entity).toBe("Signet");
		expect(conflicts.items[0]?.claimKey).toBe("mutation_policy");
		expect(conflicts.items[0]?.values).toHaveLength(2);
		expect(other.count).toBe(0);
	});

	it("applies merge_entities by moving aspects and deleting duplicate sources", () => {
		const target = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "identity",
				group_key: "product",
				claim_key: "category",
				value: "Agent-first ontology",
			},
		});
		applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: target.id, actor: "test" });

		const duplicate = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet AI",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "mutation_policy",
				value: "Proposal-first mutation loop",
			},
		});
		applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: duplicate.id, actor: "test" });

		const merge = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Signet",
				source_entities: ["Signet AI"],
			},
			rationale: "Both names refer to the same product entity.",
		});

		const applied = applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: merge.id, actor: "test" });

		expect(applied.status).toBe("applied");
		expect(applied.result?.mergedEntities).toHaveLength(1);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.name AS entity_name, asp.name AS aspect, attr.content
						 FROM entity_attributes attr
						 JOIN entity_aspects asp ON asp.id = attr.aspect_id
						 JOIN entities e ON e.id = asp.entity_id
						 WHERE e.agent_id = ? AND e.name = ?
						 ORDER BY asp.name`,
					)
					.all("ant", "Signet") as Array<{ entity_name: string; aspect: string; content: string }>,
		);
		const duplicateEntity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Signet AI") as
					| { id: string }
					| undefined,
		);

		expect(duplicateEntity).toBeNull();
		expect(rows.map((row) => row.aspect)).toEqual(["architecture", "identity"]);
		expect(rows.map((row) => row.content)).toContain("Proposal-first mutation loop");
	});

	it("applies ID-first merge_entities when entity names are ambiguous", () => {
		const target = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "identity",
				group_key: "product",
				claim_key: "category",
				value: "Context substrate",
			},
		});
		applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: target.id, actor: "test" });

		const source = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet Alias",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Proposal-first maintenance.",
			},
		});
		applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: source.id, actor: "test" });

		const ids = getDbAccessor().withWriteTx((db) => {
			const targetRow = db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Signet") as {
				id: string;
			};
			const sourceRow = db
				.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?")
				.get("ant", "Signet Alias") as { id: string };
			db.prepare("UPDATE entities SET canonical_name = ? WHERE id = ?").run("signet", sourceRow.id);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
			).run(
				"entity-signet-skill",
				"signet",
				"signet",
				"skill",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:00:00.000Z",
			);
			return { targetId: targetRow.id, sourceId: sourceRow.id };
		});

		const merge = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Signet",
				target_entity_id: ids.targetId,
				source_entities: ["Signet Alias"],
				source_entity_ids: [ids.sourceId],
			},
		});

		const applied = applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: merge.id, actor: "test" });

		expect(applied.status).toBe("applied");
		expect(applied.result?.targetEntityId).toBe(ids.targetId);
		expect(applied.result?.mergedEntities).toEqual([{ name: "Signet Alias", entityId: ids.sourceId, movedAspects: 1 }]);
	});

	it("rejects merge_entities when supplied IDs and names disagree", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8);
		insertEntity("entity-other", "Other", "other", "ant", 4);
		insertEntity("entity-alias", "Signet Alias", "signet alias", "ant", 1);

		const merge = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Other",
				target_entity_id: "entity-signet",
				source_entity_ids: ["entity-alias"],
			},
		});

		expect(() => applyOntologyProposal(getDbAccessor(), { agentId: "ant", id: merge.id, actor: "test" })).toThrow(
			OntologyProposalError,
		);
	});

	it("dry-runs duplicate entity repair candidates without creating proposals", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true);
		insertEntity("entity-signet-upper", "SIGNET", "signet", "ant", 3);
		insertEntity("entity-signet-ai", "signet.ai", "signet", "ant", 1);
		insertEntity("entity-other", "Other Project", "other project", "ant", 4);

		const result = proposeDuplicateEntityMerges(getDbAccessor(), {
			agentId: "ant",
			limit: 10,
		});

		expect(result.dryRun).toBe(true);
		expect(result.writtenCount).toBe(0);
		expect(result.count).toBe(1);
		expect(result.items[0]?.operation).toBe("merge_entities");
		expect(result.items[0]?.canonicalName).toBe("signet");
		expect(result.items[0]?.target.name).toBe("Signet");
		expect(result.items[0]?.sources.map((source) => source.name).sort()).toEqual(["SIGNET", "signet.ai"]);

		const listed = listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("blocks mixed-type duplicate entity repair proposals by default", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true, "project");
		insertEntity("entity-signet-skill", "signet", "signet", "ant", 3, false, "skill");

		const result = proposeDuplicateEntityMerges(getDbAccessor(), {
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});

		expect(result.count).toBe(1);
		expect(result.writtenCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.items[0]?.blocked).toBe(true);
		expect(result.items[0]?.warnings.join("\n")).toContain("differs from target type");
		const listed = listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("writes duplicate entity repair candidates as pending merge proposals only once", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true);
		insertEntity("entity-signet-upper", "SIGNET", "signet", "ant", 3);

		const result = proposeDuplicateEntityMerges(getDbAccessor(), {
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});
		const second = proposeDuplicateEntityMerges(getDbAccessor(), {
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});

		expect(result.dryRun).toBe(false);
		expect(result.writtenCount).toBe(1);
		expect(result.proposals[0]?.operation).toBe("merge_entities");
		expect(result.proposals[0]?.createdBy).toBe("repair-test");
		expect(result.proposals[0]?.payload.repair_kind).toBe("duplicate_entities");
		expect(result.proposals[0]?.payload.target_entity).toBe("Signet");
		expect(result.proposals[0]?.payload.source_entities).toEqual(["SIGNET"]);
		expect(second.count).toBe(0);
		expect(second.writtenCount).toBe(0);

		const listed = listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(1);
	});

	it("previews and writes manual entity merge plans with ID-first payloads", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8);
		insertEntity("entity-alias", "Signet Alias", "signet alias", "ant", 2);

		const preview = createEntityMergePlan(getDbAccessor(), {
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-alias"],
		});

		expect(preview.dryRun).toBe(true);
		expect(preview.proposal).toBeUndefined();
		expect(preview.payload.target_entity_id).toBe("entity-signet");
		expect(preview.payload.source_entity_ids).toEqual(["entity-alias"]);

		const written = createEntityMergePlan(getDbAccessor(), {
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-alias"],
			writeProposal: true,
			createdBy: "merge-plan-test",
		});

		expect(written.dryRun).toBe(false);
		expect(written.proposal?.operation).toBe("merge_entities");
		expect(written.proposal?.createdBy).toBe("merge-plan-test");
		expect(written.proposal?.payload.target_entity_id).toBe("entity-signet");
	});

	it("keeps blocked manual merge-plan writes reported as dry-runs", () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, false, "project");
		insertEntity("entity-signet-skill", "signet", "signet", "ant", 2, false, "skill");

		const result = createEntityMergePlan(getDbAccessor(), {
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-signet-skill"],
			writeProposal: true,
			createdBy: "merge-plan-test",
		});

		expect(result.blocked).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.proposal).toBeUndefined();
		const listed = listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("rejects invalid proposal batches without partial writes", () => {
		expect(() =>
			createOntologyProposals(getDbAccessor(), [
				{ agentId: "default", operation: "create_entity", payload: { name: "Valid" } },
				{ agentId: "default", operation: " ", payload: { name: "Invalid" } },
			]),
		).toThrow(OntologyProposalError);

		const listed = listOntologyProposals(getDbAccessor(), { agentId: "default" });
		expect(listed.items).toHaveLength(0);
	});

	it("keeps proposal listing scoped to agent_id", () => {
		createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "create_entity",
			payload: { name: "Ant Project" },
		});
		createOntologyProposal(getDbAccessor(), {
			agentId: "dot",
			operation: "create_entity",
			payload: { name: "Dot Project" },
		});

		const ant = listOntologyProposals(getDbAccessor(), { agentId: "ant" });
		const dot = listOntologyProposals(getDbAccessor(), { agentId: "dot" });

		expect(ant.items).toHaveLength(1);
		expect(dot.items).toHaveLength(1);
		expect(ant.items[0]?.payload.name).toBe("Ant Project");
		expect(dot.items[0]?.payload.name).toBe("Dot Project");
	});

	it("marks unsupported pending operations failed instead of mutating state", () => {
		const proposal = createOntologyProposal(getDbAccessor(), {
			agentId: "default",
			operation: "create_interface",
			payload: { source: ["A"], target: "B" },
		});

		expect(() =>
			applyOntologyProposal(getDbAccessor(), {
				agentId: "default",
				id: proposal.id,
				actor: "operator",
			}),
		).toThrow(OntologyProposalError);

		const failed = getOntologyProposal(getDbAccessor(), proposal.id, "default");
		expect(failed?.status).toBe("failed");
		expect(failed?.result?.error).toContain("Unsupported");
	});

	it("applies direct operations by creating an applied proposal and graph mutation atomically", () => {
		const result = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "control_plane",
				value: "Direct ontology operations are audited through applied proposals.",
			},
			reason: "operator asserted audited control plane behavior",
			evidence: [{ source_kind: "test", quote: "audited control plane" }],
			confidence: 0.94,
		});

		expect(result.dryRun).toBe(false);
		expect(result.proposed).toBe(false);
		expect(result.proposal.status).toBe("applied");
		expect(result.proposal.appliedBy).toBe("operator");
		expect(result.result?.version).toBe(1);

		const attrs = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "control_plane",
		});
		expect(attrs.count).toBe(1);
		expect(attrs.items[0]?.proposalId).toBe(result.proposal.id);
		expect(attrs.items[0]?.content).toContain("audited");
	});

	it("dry-runs direct operations without writing proposals or graph state", () => {
		const result = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Dry Run Entity", entity_type: "project" },
			dryRun: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.proposal.status).toBe("applied");
		const proposal = getOntologyProposal(getDbAccessor(), result.proposal.id, "ant");
		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Dry Run Entity") as
					| { id: string }
					| undefined,
		);
		expect(proposal).toBeNull();
		expect(entity).toBeNull();
	});

	it("exercises dry-run, apply, propose, reject, evidence, and immutable source artifacts end to end", () => {
		const sourcePath = "memory/codex/transcripts/control-plane-e2e.jsonl";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				sourcePath,
				"sha-control-plane-e2e",
				"transcript",
				"session-control-plane-e2e",
				"control-plane-e2e",
				"token-control-plane-e2e",
				"codex",
				"2026-05-16T00:01:00.000Z",
				"Raw artifact says ontology control-plane mutations are audited through proposals.",
				"2026-05-16T00:01:00.000Z",
			);
		});
		const sourceBefore = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("ant", sourcePath) as { content: string } | undefined,
		);

		const payload = {
			entity: "Signet",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "control_plane_e2e",
			value: "Ontology control-plane mutations are audited through proposals.",
		};
		const dryRun = applyOntologyOperationBatch(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			dryRun: true,
			operations: [{ operation: "set_claim_value", payload }],
		});
		expect(dryRun.dryRun).toBe(true);
		expect(listOntologyProposals(getDbAccessor(), { agentId: "ant" }).items).toHaveLength(0);

		const applied = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload,
			sourceKind: "transcript",
			sourceId: "control-plane-e2e",
			sourcePath,
			evidence: [{ source_kind: "memory_artifact", source_path: sourcePath, quote: "audited through proposals" }],
		});
		const proposed = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Rejected Candidate", entity_type: "project" },
			propose: true,
		});
		const rejected = rejectOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: proposed.proposal.id,
			actor: "operator",
			reason: "proposal review rejected this candidate",
		});
		const evidence = getOntologyClaimEvidence(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "control_plane_e2e",
		});
		const sourceAfter = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("ant", sourcePath) as { content: string } | undefined,
		);

		expect(applied.proposal.status).toBe("applied");
		expect(rejected.status).toBe("rejected");
		expect(evidence.items[0]?.attribute.proposalId).toBe(applied.proposal.id);
		expect(evidence.items[0]?.evidence.map((item) => item.kind)).toContain("memory_artifact");
		expect(sourceAfter?.content).toBe(sourceBefore?.content);
	});

	it("proposes direct operations without mutating graph state", () => {
		const result = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Proposed Entity", entity_type: "project" },
			propose: true,
		});

		expect(result.proposed).toBe(true);
		expect(result.proposal.status).toBe("pending");
		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Proposed Entity") as
					| { id: string }
					| undefined,
		);
		expect(entity).toBeNull();
	});

	it("set_claim_value creates queryable version chains and restore switches the active version", () => {
		const payload = {
			entity: "Signet",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "versioned_claim",
		};
		const v1 = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version one." },
		});
		const v2 = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version two." },
		});
		const v3 = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version three." },
		});

		expect(v1.result?.version).toBe(1);
		expect(v2.result?.version).toBe(2);
		expect(v3.result?.version).toBe(3);
		const versions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
		});
		expect(versions.items.map((item) => item.version)).toEqual([3, 2, 1]);
		expect(versions.items.map((item) => item.status)).toEqual(["active", "superseded", "superseded"]);

		const shown = getClaimVersion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
			version: 2,
		});
		expect(shown?.content).toBe("Version two.");

		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "restore_claim_version",
			payload: { attribute_id: shown?.id },
		});
		const restored = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
		});
		expect(restored.items.find((item) => item.version === 2)?.status).toBe("active");
		expect(restored.items.find((item) => item.version === 3)?.status).toBe("superseded");
	});

	it("archives claim values and hides them from default active reads", () => {
		const applied = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "archive_claim",
				value: "Archive me.",
			},
		});
		const attributeId = applied.result?.attributeId as string;
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "archive_claim_value",
			payload: { attribute_id: attributeId, reason: "obsolete" },
		});

		const active = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ? AND status = 'active'")
					.get(attributeId) as { n: number },
		);
		const versions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archive_claim",
		});
		expect(active.n).toBe(0);
		expect(versions.items[0]?.status).toBe("deleted");
	});

	it("continues claim version chains after the active value is archived", () => {
		const payload = {
			entity: "Archive Version Chain",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "archived_chain",
		};
		const first = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Archived first version." },
		});
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "archive_claim_value",
			payload: { attribute_id: first.result?.attributeId, reason: "retired" },
		});
		const second = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Replacement after archive." },
		});

		const versions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Archive Version Chain",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_chain",
		});

		expect(second.result?.version).toBe(2);
		expect(second.result?.versionRootId).toBe(first.result?.versionRootId);
		expect(second.result?.previousAttributeId).toBe(first.result?.attributeId);
		expect(versions.items.map((item) => item.version)).toEqual([2, 1]);
		expect(versions.items.map((item) => item.status)).toEqual(["active", "deleted"]);
	});

	it("preserves original claim provenance when repeated writes dedupe", () => {
		const first = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "set_claim_value",
			payload: {
				entity: "Dedupe Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "The original evidence owns this row.",
			},
			evidence: [{ source: "transcript:first", message_ids: ["m1"] }],
			createdBy: "first",
		});
		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: first.id,
			actor: "operator",
		});
		const repeated = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "set_claim_value",
			payload: {
				entity: "Dedupe Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "The original evidence owns this row.",
			},
			evidence: [{ source: "transcript:repeat", message_ids: ["m2"] }],
			createdBy: "repeat",
		});

		const second = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: repeated.id,
			actor: "operator",
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT proposal_id, proposal_evidence FROM entity_attributes WHERE id = ?")
					.get(applied.result?.attributeId as string) as
					| { proposal_id: string | null; proposal_evidence: string | null }
					| undefined,
		);
		expect(second.result?.deduped).toBe(true);
		expect(second.result?.attributeId).toBe(applied.result?.attributeId);
		expect(row?.proposal_id).toBe(first.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([{ source: "transcript:first", message_ids: ["m1"] }]);
	});

	it("preserves original additive claim provenance when repeated values dedupe", () => {
		const first = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Additive Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "Repeated additive values keep the first source.",
			},
			evidence: [{ source: "transcript:first-add", message_ids: ["m1"] }],
			createdBy: "first",
		});
		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: first.id,
			actor: "operator",
		});
		const repeated = createOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Additive Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "Repeated additive values keep the first source.",
			},
			evidence: [{ source: "transcript:repeat-add", message_ids: ["m2"] }],
			createdBy: "repeat",
		});

		const second = applyOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: repeated.id,
			actor: "operator",
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT proposal_id, proposal_evidence FROM entity_attributes WHERE id = ?")
					.get(applied.result?.attributeId as string) as
					| { proposal_id: string | null; proposal_evidence: string | null }
					| undefined,
		);
		expect(second.result?.deduped).toBe(true);
		expect(second.result?.attributeId).toBe(applied.result?.attributeId);
		expect(row?.proposal_id).toBe(first.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([
			{ source: "transcript:first-add", message_ids: ["m1"] },
		]);
	});

	it("records the applying actor when pending archive proposals are applied", () => {
		const entity = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "creator",
			operation: "create_entity",
			payload: { name: "Archive Actor Entity", entity_type: "project" },
		});
		const claim = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "creator",
			operation: "set_claim_value",
			payload: {
				entity: "Archive Actor Claim",
				entity_type: "project",
				aspect: "audit",
				group_key: "ontology",
				claim_key: "actor",
				value: "Archive me.",
			},
		});
		const link = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "creator",
			operation: "create_link",
			payload: {
				source_entity: "Archive Actor Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archive Actor Target",
				target_type: "project",
				reason: "Audit actor fixture.",
			},
		});
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "creator",
			operation: "set_claim_value",
			payload: {
				entity: "Archive Actor Aspect",
				entity_type: "project",
				aspect: "retire_me",
				group_key: "ontology",
				claim_key: "actor",
				value: "Archive my aspect.",
			},
		});

		const proposals = createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "archive_entity",
				payload: { selector: entity.result?.entityId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_claim_value",
				payload: { attribute_id: claim.result?.attributeId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_link",
				payload: { id: link.result?.dependencyId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_aspect",
				payload: { entity: "Archive Actor Aspect", selector: "retire_me" },
				createdBy: "creator",
			},
		]);

		for (const proposal of proposals.items) {
			applyOntologyProposal(getDbAccessor(), {
				agentId: "ant",
				id: proposal.id,
				actor: "reviewer",
			});
		}

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT
						 (SELECT archived_by FROM entities WHERE id = ?) AS entity_actor,
						 (SELECT archived_by FROM entity_attributes WHERE id = ?) AS claim_actor,
						 (SELECT archived_by FROM entity_dependencies WHERE id = ?) AS link_actor,
						 (SELECT asp.archived_by
						    FROM entity_aspects asp
						    JOIN entities ent ON ent.id = asp.entity_id
						   WHERE ent.agent_id = ? AND ent.name = ? AND asp.name = ?) AS aspect_actor,
						 (SELECT attr.archived_by
						    FROM entity_attributes attr
						    JOIN entity_aspects asp ON asp.id = attr.aspect_id
						    JOIN entities ent ON ent.id = asp.entity_id
						   WHERE ent.agent_id = ? AND ent.name = ? AND asp.name = ?) AS aspect_attr_actor`,
					)
					.get(
						entity.result?.entityId as string,
						claim.result?.attributeId as string,
						link.result?.dependencyId as string,
						"ant",
						"Archive Actor Aspect",
						"retire_me",
						"ant",
						"Archive Actor Aspect",
						"retire_me",
					) as {
					entity_actor: string | null;
					claim_actor: string | null;
					link_actor: string | null;
					aspect_actor: string | null;
					aspect_attr_actor: string | null;
				},
		);
		expect(row).toEqual({
			entity_actor: "reviewer",
			claim_actor: "reviewer",
			link_actor: "reviewer",
			aspect_actor: "reviewer",
			aspect_attr_actor: "reviewer",
		});
	});

	it("reactivates archived aspects when creating claims for the same aspect slot", () => {
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Aspect Restore",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "old_claim",
				value: "Before archive.",
			},
		});
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "archive_aspect",
			payload: { entity: "Aspect Restore", selector: "architecture", reason: "retired" },
		});
		const recreated = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Aspect Restore",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "new_claim",
				value: "After archive.",
			},
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT asp.status AS aspect_status, asp.archived_by, attr.status AS claim_status
						 FROM entity_aspects asp
						 JOIN entity_attributes attr ON attr.aspect_id = asp.id
						 WHERE asp.id = ? AND attr.id = ?`,
					)
					.get(recreated.result?.aspectId as string, recreated.result?.attributeId as string) as
					| { aspect_status: string; archived_by: string | null; claim_status: string }
					| undefined,
		);
		expect(row?.aspect_status).toBe("active");
		expect(row?.archived_by).toBeNull();
		expect(row?.claim_status).toBe("active");
	});

	it("reactivates archived links when creating the same link again", () => {
		const created = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "create_link",
			payload: {
				source_entity: "Archived Link Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archived Link Target",
				target_type: "project",
				reason: "Initial relationship.",
			},
		});
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "archive_link",
			payload: { id: created.result?.dependencyId, reason: "retired" },
		});
		const recreated = applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "create_link",
			payload: {
				source_entity: "Archived Link Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archived Link Target",
				target_type: "project",
				reason: "Restored relationship.",
				strength: 0.9,
			},
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT status, archived_by, reason, strength FROM entity_dependencies WHERE id = ?")
					.get(created.result?.dependencyId as string) as
					| { status: string; archived_by: string | null; reason: string; strength: number }
					| undefined,
		);
		expect(recreated.result?.dependencyId).toBe(created.result?.dependencyId);
		expect(recreated.result?.reactivated).toBe(true);
		expect(row?.status).toBe("active");
		expect(row?.archived_by).toBeNull();
		expect(row?.reason).toBe("Restored relationship.");
		expect(row?.strength).toBeCloseTo(0.9);
	});

	it("keeps claim version history readable after archiving its parent entity", () => {
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "archived_parent_history",
				value: "History survives entity archival.",
			},
		});
		applyOntologyOperation(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			operation: "archive_entity",
			payload: { selector: "Signet", reason: "retired" },
		});

		const versions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_parent_history",
		});
		const version = getClaimVersion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_parent_history",
			version: 1,
		});
		expect(versions.count).toBe(1);
		expect(version?.content).toBe("History survives entity archival.");
	});

	it("requires strict claim-version entity selectors across archived duplicates", () => {
		insertEntity("archived-history", "Duplicate History A", "duplicate history", "ant", 1);
		insertEntity("active-history", "Duplicate History B", "duplicate history", "ant", 2);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run("archived-history");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run("archived-history-aspect", "archived-history", "ant", "architecture", "architecture");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run("active-history-aspect", "active-history", "ant", "architecture", "architecture");
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
			).run(
				"archived-history-attr",
				"archived-history-aspect",
				"ant",
				"Archived entity history.",
				"archived entity history.",
				"ontology",
				"lineage",
				"archived-history-attr",
			);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
			).run(
				"active-history-attr",
				"active-history-aspect",
				"ant",
				"Active entity history.",
				"active entity history.",
				"ontology",
				"lineage",
				"active-history-attr",
			);
		});

		expect(() =>
			listClaimVersions(getDbAccessor(), {
				agentId: "ant",
				entity: "duplicate history",
				aspect: "architecture",
				group: "ontology",
				claim: "lineage",
			}),
		).toThrow("ambiguous");
		const archivedVersions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "archived-history",
			aspect: "archived-history-aspect",
			group: "ontology",
			claim: "lineage",
		});
		const activeVersions = listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "active-history",
			aspect: "active-history-aspect",
			group: "ontology",
			claim: "lineage",
		});
		expect(archivedVersions.items.map((item) => item.content)).toEqual(["Archived entity history."]);
		expect(activeVersions.items.map((item) => item.content)).toEqual(["Active entity history."]);
	});

	it("rolls back an operation batch when one operation is invalid", () => {
		expect(() =>
			applyOntologyOperationBatch(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operations: [
					{ operation: "create_entity", payload: { name: "Batch Good", entity_type: "project" } },
					{ operation: "rename_entity", payload: { selector: "Missing", new_name: "Nope" } },
				],
			}),
		).toThrow(OntologyProposalError);
		const count = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Batch Good") as {
					n: number;
				},
		);
		expect(count.n).toBe(0);
		expect(listOntologyProposals(getDbAccessor(), { agentId: "ant" }).items).toHaveLength(0);
	});

	it("returns per-line dry-run batch validation errors without writing", () => {
		const result = applyOntologyOperationBatch(getDbAccessor(), {
			agentId: "ant",
			actor: "operator",
			dryRun: true,
			operations: [
				{ operation: "create_entity", payload: { name: "Batch Preview", entity_type: "project" } },
				{ operation: "rename_entity", payload: { selector: "Missing", new_name: "Nope" } },
			],
		});
		const count = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND name = ?")
					.get("ant", "Batch Preview") as {
					n: number;
				},
		);

		expect(result.dryRun).toBe(true);
		expect(result.items).toHaveLength(1);
		expect(result.errors).toEqual([
			{
				index: 1,
				line: 2,
				operation: "rename_entity",
				error: "Entity not found: Missing",
				status: 404,
			},
		]);
		expect(count.n).toBe(0);
		expect(listOntologyProposals(getDbAccessor(), { agentId: "ant" }).items).toHaveLength(0);
	});

	it("rejects ambiguous same-agent entity selectors", () => {
		insertEntity("one", "Signet A", "signet", "ant", 1);
		insertEntity("two", "Signet B", "signet", "ant", 2);

		expect(() =>
			applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "rename_entity",
				payload: { selector: "signet", new_name: "Signet" },
			}),
		).toThrow("ambiguous");
	});
});
