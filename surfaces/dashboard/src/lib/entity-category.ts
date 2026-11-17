export type EntityCategory =
	| "person"
	| "organization"
	| "place"
	| "project"
	| "tool"
	| "artifact"
	| "event"
	| "document"
	| "other";

const BY_TYPE: Readonly<Record<string, EntityCategory>> = {
	person: "person",
	organization: "organization",
	company: "organization",
	team: "organization",
	place: "place",
	location: "place",
	project: "project",
	work: "project",
	tool: "tool",
	system: "tool",
	service: "tool",
	product: "tool",
	software: "tool",
	artifact: "artifact",
	file: "artifact",
	event: "event",
	source_document: "document",
	source_document_reference: "document",
	document: "document",
};

export const ENTITY_CATEGORIES: ReadonlyArray<{ readonly key: EntityCategory; readonly label: string }> = [
	{ key: "person", label: "People" },
	{ key: "organization", label: "Organizations" },
	{ key: "place", label: "Places" },
	{ key: "project", label: "Projects" },
	{ key: "tool", label: "Tools & systems" },
	{ key: "artifact", label: "Artifacts" },
	{ key: "event", label: "Events" },
	{ key: "document", label: "Documents" },
	{ key: "other", label: "Other" },
];

const DARK: Readonly<Record<EntityCategory, string>> = {
	person: "#f59e6b",
	organization: "#e58bd0",
	place: "#e8c95a",
	project: "#7aa2ff",
	tool: "#9ad46a",
	artifact: "#b49bff",
	event: "#5fd0d8",
	document: "#8fa3bf",
	other: "#c4c4cc",
};

const LIGHT: Readonly<Record<EntityCategory, string>> = {
	person: "#c2410c",
	organization: "#a21caf",
	place: "#a16207",
	project: "#2563eb",
	tool: "#4d7c0f",
	artifact: "#7c3aed",
	event: "#0e7490",
	document: "#475569",
	other: "#52525b",
};

export function entityCategory(entityType: string): EntityCategory {
	return BY_TYPE[entityType.trim().toLowerCase()] ?? "other";
}

export function categoryColor(category: EntityCategory, dark: boolean): string {
	return (dark ? DARK : LIGHT)[category];
}
