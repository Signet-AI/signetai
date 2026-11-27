import { expect, test } from "bun:test";
import { z } from "zod";
import {
	DREAMING_OPERATION_IDS,
	DREAMING_ONTOLOGY_OPERATION_SCHEMA,
	DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS,
} from "./dreaming-operation-contract";

test("Dreaming create_link exposes and validates its dependency reason", () => {
	const payload = {
		fromEntityId: "a",
		toEntityId: "b",
		linkType: "related_to",
		reason: "They share a release process.",
	};
	expect(z.toJSONSchema(DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS.create_link)).toMatchObject({
		properties: { reason: { type: "string" } },
	});
	expect(DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS.create_link.parse(payload)).toMatchObject({ reason: payload.reason });
	expect(DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS.create_link.safeParse({ ...payload, reason: 7 }).success).toBe(false);
});

test("Dreaming claim operations accept id-based targets", () => {
	const input = {
		operation: "set_claim_value" as const,
		payload: {
			entityId: "e-signet",
			aspectId: "a-identity",
			claimKey: "purpose",
			value: "Signet preserves durable agent context.",
		},
	};
	expect(DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse(input).success).toBe(true);
});

test("Dreaming operations expose the shared entity-type vocabulary", () => {
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			operation: "create_entity",
			payload: { name: "Signet", type: "system" },
		}).success,
	).toBe(true);
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			operation: "create_entity",
			payload: { name: "Signet", type: "made_up_type" },
		}).success,
	).toBe(false);
});

test("flag ops are part of the Dreaming vocabulary", () => {
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			operation: "flag",
			payload: { subjectRef: "entity:e-husk", details: { reason: "zero_active_attributes" } },
		}).success,
	).toBe(true);
});

test("decline_attention is part of the Dreaming vocabulary and requires an attentionId", () => {
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			operation: "decline_attention",
			payload: { attentionId: "attention-uuid" },
		}).success,
	).toBe(true);
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			operation: "decline_attention",
			payload: {},
		}).success,
	).toBe(false);
});

test("Dreaming contract admits canonical alias operations with evidence and reject incomplete payloads", () => {
	for (const operation of ["create_entity_alias", "archive_entity_alias"] as const) {
		expect(DREAMING_OPERATION_IDS).toContain(operation);
		const payload =
			operation === "create_entity_alias"
				? { entity_id: "public-parent", alias: "Private name", reason: "Evidence supplies this name." }
				: { entity_id: "public-parent", alias_id: "private-alias", reason: "Evidence retracts this name." };
		const input = {
			operation,
			payload,
			reason: "Evidence-backed alias lifecycle.",
			evidence: [{ source_ref: "memory:secret", quote: "Private name" }],
		};
		expect(DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse(input).success).toBe(true);
		expect(
			DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({ ...input, payload: { entity_id: "public-parent" } }).success,
		).toBe(false);
		expect(
			DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({ ...input, payload: { ...payload, entity_id: 7 } }).success,
		).toBe(false);
		const json = z.toJSONSchema(DREAMING_ONTOLOGY_OPERATION_SCHEMA);
		expect(JSON.stringify(json)).toContain(operation);
	}
});
