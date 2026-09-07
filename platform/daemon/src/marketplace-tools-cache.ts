import type { MarketplaceMcpServerHealth, MarketplaceMcpTool } from "./routes/marketplace.js";

export interface MarketplaceToolsCache {
	readonly fetchedAt: number;
	readonly tools: readonly MarketplaceMcpTool[];
	readonly serverHealth: readonly MarketplaceMcpServerHealth[];
}

export const marketplaceToolsCache = new Map<string, MarketplaceToolsCache>();
export const marketplaceToolsLoadInFlight = new Map<string, Promise<MarketplaceToolsCache>>();

export function invalidateMarketplaceToolsCache(): void {
	marketplaceToolsCache.clear();
}
