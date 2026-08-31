export type SyncDbSourceLocationToken = `${string}:${number}`;
export type SyncDbSemanticSiteToken = `db:${string}.${string}.${string}`;
export type SyncDbCallSiteToken = SyncDbSourceLocationToken | SyncDbSemanticSiteToken;

const SOURCE_LOCATION_TOKEN = /^\/?[^:/\s]+(?:\/[^:/\s]+)*:\d+$/;
const SEMANTIC_TOKEN = /^db:[a-z0-9]+(?:[.-][a-z0-9]+){2,}$/;

export type SyncDbSiteTokenKind = "source-location" | "semantic";

export function classifySyncDbSiteToken(token: string): SyncDbSiteTokenKind | null {
	if (SOURCE_LOCATION_TOKEN.test(token)) return "source-location";
	if (SEMANTIC_TOKEN.test(token)) return "semantic";
	return null;
}

export function isSemanticSyncDbSiteToken(token: string | null): token is SyncDbSemanticSiteToken {
	return token !== null && classifySyncDbSiteToken(token) === "semantic";
}
