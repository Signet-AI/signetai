import { expect, test } from "bun:test";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";

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
