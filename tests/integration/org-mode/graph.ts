import assert from "node:assert/strict";
import type { Fixture } from "./fixture";
import { record, request, success, text } from "./http";

export interface Evidence {
	source_ref: string;
	quote: string;
}
export async function dreamOperation(
	fixture: Pick<Fixture, "daemon" | "admin" | "users" | "engAgent">,
	agentId: string,
	operation: string,
	payload: object,
	evidence: Evidence[],
): Promise<Record<string, unknown>> {
	const endpoint = "/api/dream/tools/apply_ontology_ops";
	const user =
		[...fixture.users.values()].find((user) => user.agentId === agentId) ??
		(agentId === fixture.engAgent ? fixture.users.get("alice") : undefined);
	assert(user, "Dreaming fixture must use an actor permitted to act as the target agent");
	const reply = await request(fixture.daemon.origin, endpoint, user.session, "POST", {
		agentId,
		input: { agentId, operations: [{ operation, payload, evidence }] },
	});
	assert(reply.status >= 200 && reply.status < 300, `${operation}: ${JSON.stringify(reply.body)}`);
	const body = success(reply, `POST ${endpoint}: ${operation}`);
	assert.equal(body.ok, true, `${endpoint}: ${operation} failed`);
	assert(Array.isArray(body.items) && body.items.length === 1, `${endpoint}: expected exactly one operation result`);
	const item = record(body.items[0]);
	assert.equal(item.ok, true, `${endpoint}: ${operation} did not apply`);
	return record(item.result);
}
export async function deriveClaim(
	fixture: Pick<Fixture, "daemon" | "admin" | "users" | "engAgent">,
	agentId: string,
	memoryId: string,
	quote: string,
	name: string,
	value = quote,
) {
	const evidence = [{ source_ref: `memory:${memoryId}`, quote }];
	const entity = await dreamOperation(fixture, agentId, "create_entity", { name, type: "project" }, evidence);
	const entityId = text(entity.entityId);
	const aspect = await dreamOperation(fixture, agentId, "create_aspect", { entityId, name: "HR" }, evidence);
	const result = await dreamOperation(
		fixture,
		agentId,
		"add_claim_value",
		{ entityId, aspectId: text(aspect.aspectId), group_key: "compensation", claimKey: "award", value },
		evidence,
	);
	return {
		entityId,
		aspectId: text(aspect.aspectId),
		attributeId: text(result.attributeId),
		memoryId: text(result.memoryId),
	};
}
