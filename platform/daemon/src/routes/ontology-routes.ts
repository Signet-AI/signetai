import type { Context, Hono } from "hono";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProviderOrNull } from "../llm";
import {
	OntologyClaimEvidenceError,
	getOntologyClaimEvidence,
	parseOntologyClaimAttributeKind,
	parseOntologyClaimAttributeStatus,
} from "../ontology-claim-evidence";
import { OntologyConsolidationError, consolidateOntologyProposals } from "../ontology-consolidation";
import { OntologyExtractionError, extractOntologyProposals } from "../ontology-extraction";
import { OntologyLinkEvidenceError, getOntologyLinkEvidence } from "../ontology-link-evidence";
import {
	OntologyProposalError,
	applyOntologyProposal,
	createOntologyProposal,
	createOntologyProposals,
	getOntologyProposal,
	getOntologyProposalEvidence,
	listOntologyProposalConflicts,
	listOntologyProposals,
	parseOntologyProposalStatus,
	proposeDuplicateEntityMerges,
	rejectOntologyProposal,
} from "../ontology-proposals";
import { authConfig } from "./state";
import { parseBoundedInt, resolveScopedAgentId } from "./utils";

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
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

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] | undefined {
	const value = record[key];
	return Array.isArray(value) ? value : undefined;
}

async function readJsonRecord(c: Context): Promise<Record<string, unknown>> {
	try {
		return asRecord(await c.req.json());
	} catch {
		return {};
	}
}

function statusForError(err: unknown): 400 | 404 | 409 | 500 {
	if (err instanceof OntologyProposalError) return err.status;
	if (err instanceof OntologyClaimEvidenceError) return err.status;
	if (err instanceof OntologyLinkEvidenceError) return err.status;
	if (err instanceof OntologyExtractionError) return err.status;
	if (err instanceof OntologyConsolidationError) return err.status;
	return 500;
}

function messageForError(err: unknown): string {
	return err instanceof Error ? err.message : "Ontology proposal request failed";
}

function resolveAgent(c: Context, requested: string | undefined): { agentId: string; response?: Response } {
	const scoped = resolveScopedAgentId(c, requested);
	if (scoped.error) {
		return { agentId: scoped.agentId, response: c.json({ error: scoped.error }, 403) };
	}
	return { agentId: scoped.agentId };
}

export function registerOntologyRoutes(app: Hono): void {
	app.use("/api/ontology/proposals", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});
	app.use("/api/ontology/proposals/*", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});
	app.use("/api/ontology/extract", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});
	app.use("/api/ontology/consolidate", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});
	app.use("/api/ontology/claims/*", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});
	app.use("/api/ontology/links/*", async (c, next) => {
		const permission = c.req.method === "GET" ? "recall" : "modify";
		return requirePermission(permission, authConfig)(c, next);
	});

	app.get("/api/ontology/proposals", (c) => {
		const status = parseOntologyProposalStatus(c.req.query("status"));
		if (c.req.query("status") && !status) return c.json({ error: "status is invalid" }, 400);
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		const operation = c.req.query("operation")?.trim() || undefined;
		return c.json(
			listOntologyProposals(getDbAccessor(), {
				agentId: scoped.agentId,
				status,
				operation,
				limit: parseBoundedInt(c.req.query("limit"), 50, 1, 200),
				offset: parseBoundedInt(c.req.query("offset"), 0, 0, 10_000),
			}),
		);
	});

	app.get("/api/ontology/proposals/conflicts", (c) => {
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		return c.json(
			listOntologyProposalConflicts(getDbAccessor(), {
				agentId: scoped.agentId,
				limit: parseBoundedInt(c.req.query("limit"), 500, 1, 1000),
			}),
		);
	});

	app.post("/api/ontology/proposals/repair/duplicates", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		try {
			return c.json(
				proposeDuplicateEntityMerges(getDbAccessor(), {
					agentId: scoped.agentId,
					limit: readNumber(body, "limit"),
					writeProposals: readBoolean(body, "write_proposals") ?? false,
					createdBy: readString(body, "created_by") ?? c.req.header("x-signet-actor") ?? "operator",
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.post("/api/ontology/extract", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		const from = readString(body, "from");
		if (!from) return c.json({ error: "from is required" }, 400);
		const useProvider = readBoolean(body, "use_provider") ?? false;
		try {
			return c.json(
				await extractOntologyProposals(getDbAccessor(), {
					agentId: scoped.agentId,
					from,
					writeProposals: readBoolean(body, "write_proposals") ?? false,
					createdBy: readString(body, "created_by") ?? c.req.header("x-signet-actor") ?? "ontology-extract",
					limit: readNumber(body, "limit"),
					useProvider,
					provider: useProvider ? getInferenceProviderOrNull("memoryExtraction") : null,
					providerTimeoutMs: readNumber(body, "provider_timeout_ms"),
					providerMaxTokens: readNumber(body, "provider_max_tokens"),
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.post("/api/ontology/consolidate", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		const status = parseOntologyProposalStatus(readString(body, "status"));
		if (readString(body, "status") && !status) return c.json({ error: "status is invalid" }, 400);
		const useProvider = readBoolean(body, "use_provider") ?? false;
		try {
			return c.json(
				await consolidateOntologyProposals(getDbAccessor(), {
					agentId: scoped.agentId,
					status,
					limit: readNumber(body, "limit"),
					writeProposals: readBoolean(body, "write_proposals") ?? false,
					createdBy: readString(body, "created_by") ?? c.req.header("x-signet-actor") ?? "ontology-consolidate",
					useProvider,
					provider: useProvider ? getInferenceProviderOrNull("memoryExtraction") : null,
					providerTimeoutMs: readNumber(body, "provider_timeout_ms"),
					providerMaxTokens: readNumber(body, "provider_max_tokens"),
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.get("/api/ontology/proposals/:id/evidence", (c) => {
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		try {
			return c.json(getOntologyProposalEvidence(getDbAccessor(), c.req.param("id"), scoped.agentId));
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.get("/api/ontology/claims/evidence", (c) => {
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		const entity = c.req.query("entity")?.trim();
		const aspect = c.req.query("aspect")?.trim();
		const group = c.req.query("group")?.trim();
		const claim = c.req.query("claim")?.trim();
		if (!entity) return c.json({ error: "entity is required" }, 400);
		if (!aspect) return c.json({ error: "aspect is required" }, 400);
		if (!group) return c.json({ error: "group is required" }, 400);
		if (!claim) return c.json({ error: "claim is required" }, 400);
		const kind = parseOntologyClaimAttributeKind(c.req.query("kind"));
		if (c.req.query("kind") && !kind) return c.json({ error: "kind is invalid" }, 400);
		const status = parseOntologyClaimAttributeStatus(c.req.query("status"));
		if (c.req.query("status") && !status) return c.json({ error: "status is invalid" }, 400);
		try {
			return c.json(
				getOntologyClaimEvidence(getDbAccessor(), {
					agentId: scoped.agentId,
					entity,
					aspect,
					group,
					claim,
					kind,
					status,
					limit: parseBoundedInt(c.req.query("limit"), 20, 1, 200),
					offset: parseBoundedInt(c.req.query("offset"), 0, 0, 10_000),
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.get("/api/ontology/links/:id/evidence", (c) => {
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		try {
			return c.json(getOntologyLinkEvidence(getDbAccessor(), { agentId: scoped.agentId, id: c.req.param("id") }));
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.get("/api/ontology/proposals/:id", (c) => {
		const scoped = resolveAgent(c, c.req.query("agent_id"));
		if (scoped.response) return scoped.response;
		const proposal = getOntologyProposal(getDbAccessor(), c.req.param("id"), scoped.agentId);
		if (proposal === null) return c.json({ error: "Proposal not found" }, 404);
		return c.json(proposal);
	});

	app.post("/api/ontology/proposals", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		const operation = readString(body, "operation");
		if (!operation) return c.json({ error: "operation is required" }, 400);
		const payload = asRecord(body.payload);
		if (Object.keys(payload).length === 0) return c.json({ error: "payload object is required" }, 400);
		const evidence = Array.isArray(body.evidence) ? body.evidence : undefined;

		try {
			return c.json(
				createOntologyProposal(getDbAccessor(), {
					agentId: scoped.agentId,
					operation,
					payload,
					confidence: readNumber(body, "confidence"),
					rationale: readString(body, "rationale"),
					evidence,
					risk: readString(body, "risk") ?? null,
					sourceKind: readString(body, "source_kind") ?? null,
					sourceId: readString(body, "source_id") ?? null,
					sourcePath: readString(body, "source_path") ?? null,
					sourceRoot: readString(body, "source_root") ?? null,
					createdBy: readString(body, "created_by") ?? c.req.header("x-signet-actor") ?? "operator",
				}),
				201,
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.post("/api/ontology/proposals/batch", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		const createdBy = readString(body, "created_by") ?? c.req.header("x-signet-actor") ?? "operator";
		const sourceKind = readString(body, "source_kind") ?? null;
		const sourceId = readString(body, "source_id") ?? null;
		const sourcePath = readString(body, "source_path") ?? null;
		const sourceRoot = readString(body, "source_root") ?? null;
		const proposals = readArray(body, "proposals") ?? [];

		try {
			return c.json(
				createOntologyProposals(
					getDbAccessor(),
					proposals.map((raw) => {
						const proposal = asRecord(raw);
						const operation = readString(proposal, "operation") ?? "";
						const payload = asRecord(proposal.payload);
						return {
							agentId: scoped.agentId,
							operation,
							payload,
							confidence: readNumber(proposal, "confidence"),
							rationale: readString(proposal, "rationale"),
							evidence: readArray(proposal, "evidence"),
							risk: readString(proposal, "risk") ?? null,
							sourceKind: readString(proposal, "source_kind") ?? sourceKind,
							sourceId: readString(proposal, "source_id") ?? sourceId,
							sourcePath: readString(proposal, "source_path") ?? sourcePath,
							sourceRoot: readString(proposal, "source_root") ?? sourceRoot,
							createdBy: readString(proposal, "created_by") ?? createdBy,
						};
					}),
				),
				201,
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.post("/api/ontology/proposals/:id/apply", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		try {
			return c.json(
				applyOntologyProposal(getDbAccessor(), {
					agentId: scoped.agentId,
					id: c.req.param("id"),
					actor: readString(body, "actor") ?? c.req.header("x-signet-actor") ?? "operator",
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});

	app.post("/api/ontology/proposals/:id/reject", async (c) => {
		const body = await readJsonRecord(c);
		const scoped = resolveAgent(c, c.req.query("agent_id") ?? readString(body, "agent_id"));
		if (scoped.response) return scoped.response;
		try {
			return c.json(
				rejectOntologyProposal(getDbAccessor(), {
					agentId: scoped.agentId,
					id: c.req.param("id"),
					actor: readString(body, "actor") ?? c.req.header("x-signet-actor") ?? "operator",
					reason: readString(body, "reason"),
				}),
			);
		} catch (err) {
			return c.json({ error: messageForError(err) }, statusForError(err));
		}
	});
}
