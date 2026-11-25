import type { DbOwnerParameter } from "./db-owner-protocol";
import type { AudienceSubject, ReadScope } from "./read-scope";
const namedReadOperations = [
	"sources.stats_artifacts",
	"sources.stats_chunks",
	"sources.health_orphan_chunks",
	"sources.health_live_paths",
	"sources.health_artifacts",
	"sources.health_failures",
	"sources.health_discord",
	"sources.health_entities",
	"sources.health_document_entity",
	"sources.health_aspects",
	"sources.health_attributes",
	"sources.health_dependencies",
	"sources.health_communities",
	"sources.import.list",
	"sources.import.export",
	"sources.import.export.content",
	"sources.import.status",
	"sources.import.files",
	"sources.import.rejections",
	"sources.import.reconciliation",
	"memory.projection.threads",
	"memory.projection.top",
	"memory.projection.temporal",
	"memory.projection.ledger",
] as const;
export type NamedReadOperation = (typeof namedReadOperations)[number];
export function namedReadOperation(value: string): NamedReadOperation {
	const match = namedReadOperations.find((operation) => operation === value);
	if (!match) throw new Error("Unknown content read operation");
	return match;
}
export interface NamedContentReadRequest {
	readonly op: NamedReadOperation;
	readonly scope: ReadScope;
	readonly parameters: readonly DbOwnerParameter[];
	readonly subject?: AudienceSubject;
	readonly filters?: {
		readonly harnesses: number;
		readonly offset?: number;
		readonly since: boolean;
		readonly until: boolean;
		readonly cursor: boolean;
	};
}
