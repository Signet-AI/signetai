import assert from "node:assert/strict";
import type { Fixture } from "./fixture";
import { record, request, success, text } from "./http";

type GraphFixture = Pick<Fixture, "daemon" | "admin"> & Partial<Pick<Fixture, "users" | "engAgent">>;

export interface Evidence {
	source_ref: string;
	quote: string;
}
export async function graphOperation(
	fixture: GraphFixture,
	agentId: string,
	operation: string,
	payload: object,
	evidence: Evidence[],
): Promise<Record<string, unknown>> {
	const endpoint = "/api/ontology/operations/apply";
	const user =
		[...(fixture.users?.values() ?? [])].find((user) => user.agentId === agentId) ??
		(agentId === fixture.engAgent ? fixture.users?.get("alice") : undefined);
	assert(fixture.users === undefined || user, "Graph fixture target must have an admitted owner");
	const reply = await request(fixture.daemon.origin, endpoint, user?.session ?? fixture.admin, "POST", {
		agent_id: agentId,
		operation,
		payload,
		evidence,
		reason: record(payload).reason,
		confidence: 0.9,
	});
	assert(reply.status >= 200 && reply.status < 300, `${operation}: ${JSON.stringify(reply.body)}`);
	const body = success(reply, `POST ${endpoint}: ${operation}`);
	const proposal = record(body.proposal);
	assert.equal(proposal.agentId, agentId, "Graph fixture operation must retain its requested agent");
	assert.equal(proposal.operation, operation);
	assert.equal(proposal.status, "applied");
	assert.equal(body.dryRun, false);
	assert.equal(body.proposed, false);
	assert(Array.isArray(proposal.evidence) && proposal.evidence.length === evidence.length);
	return record(body.result);
}
export async function deriveClaim(
	fixture: GraphFixture,
	agentId: string,
	memoryId: string,
	quote: string,
	name: string,
	value = quote,
) {
	const evidence = [{ source_ref: `memory:${memoryId}`, quote }];
	const entity = await graphOperation(fixture, agentId, "create_entity", { name, entity_type: "project" }, evidence);
	const entityId = text(entity.entityId);
	const aspect = await graphOperation(fixture, agentId, "create_aspect", { entity_id: entityId, name: "HR" }, evidence);
	const result = await graphOperation(
		fixture,
		agentId,
		"add_claim_value",
		{ entity: entityId, aspect: text(aspect.aspectId), claim_key: "award", value },
		evidence,
	);
	return {
		entityId,
		aspectId: text(aspect.aspectId),
		attributeId: text(result.attributeId),
		memoryId: text(result.memoryId),
	};
}
