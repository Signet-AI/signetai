export const MARKETING_PRODUCTION_HOSTNAMES = ["signetai.sh", "www.signetai.sh"] as const;
export const MARKETING_DEPLOYMENT = "production" as const;

export function isProductionMarketingHost(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	return MARKETING_PRODUCTION_HOSTNAMES.some((candidate) => candidate === normalized);
}

export function shouldEnableMarketingAnalytics(hostname: string, apiKey: string, environment: string): boolean {
	return environment === MARKETING_DEPLOYMENT && apiKey.trim().length > 0 && isProductionMarketingHost(hostname);
}
