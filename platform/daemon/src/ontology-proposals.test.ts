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
	applyOntologyProposal,
	createOntologyProposal,
	createOntologyProposals,
	getOntologyProposal,
	getOntologyProposalEvidence,
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
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				canonicalName,
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
});
