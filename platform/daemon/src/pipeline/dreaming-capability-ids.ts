/** Lightweight canonical ids shared by Dreaming runtimes and launch policy. */
export const DREAMING_CAPABILITY_IDS = [
	"memory_head_read",
	"memory_head_commit",
	"search_entities",
	"get_entity",
	"list_aspect_claims",
	"walk_links",
	"get_evidence",
	"search_evidence",
	"validate_proposal",
	"list_contradictions",
	"runbook_read",
	"runbook_write",
	"attention_list",
	"apply_ontology_ops",
	"curate_memory_head",
] as const;

export type DreamingCapabilityId = (typeof DREAMING_CAPABILITY_IDS)[number];
