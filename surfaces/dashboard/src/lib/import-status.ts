export type DurableImportState = "pending" | "processing" | "imported" | "duplicate" | "failed" | "quarantined";
export interface ImportInboxEntry {
	readonly kind: "inbox";
	readonly id: string;
}
export function importStatusLabel(state: DurableImportState): string {
	return {
		pending: "Pending admission",
		processing: "Processing",
		imported: "Imported",
		duplicate: "Duplicate",
		failed: "Failed",
		quarantined: "Quarantined",
	}[state];
}
export function isInboxEntry(value: { readonly kind?: string }): value is ImportInboxEntry {
	return value.kind === "inbox";
}
export function importStatusReason(state: DurableImportState): string | undefined {
	if (state === "duplicate") return "Already admitted; choose replace or reimport to create a new version.";
	if (state === "failed") return "Admission failed; retry to reconcile the durable job.";
	if (state === "quarantined") return "Held for review; it is not indexed or configured as a Source.";
	return undefined;
}
