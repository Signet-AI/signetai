/**
 * @signet/connector-ghl
 *
 * GHL OAuth connector for Signet — bootstrap your agent with full
 * GoHighLevel account context on first connect.
 *
 * @example
 * ```typescript
 * import { GHLConnector, REQUIRED_SCOPES } from '@signet/connector-ghl';
 *
 * const connector = new GHLConnector({
 *   oauth: {
 *     clientId: process.env.GHL_CLIENT_ID!,
 *     clientSecret: process.env.GHL_CLIENT_SECRET!,
 *     redirectUri: 'http://localhost:3850/api/ghl/callback',
 *     scopes: [...REQUIRED_SCOPES],
 *   },
 * });
 *
 * // Start OAuth flow
 * const authUrl = connector.getAuthorizationUrl('my-state');
 * // redirect user to authUrl...
 *
 * // Handle callback
 * const account = await connector.handleCallback(code, { onProgress: console.log });
 * // agent memory is now bootstrapped with GHL account context
 * ```
 */

export { GHLConnector, MemoryStorage } from "./connector.js";
export type { GHLStorage } from "./connector.js";

export {
	buildAuthorizationUrl,
	exchangeCodeForTokens,
	refreshTokens,
	ensureValidTokens,
	ghlApiFetch,
	ghlApiPaginate,
	REQUIRED_SCOPES,
} from "./oauth.js";

export { discoverLocation, computeHealthScore } from "./discovery.js";
export { analyzeGaps, executeAutoFixes } from "./gap-analysis.js";
export { ingestDiscovery, ingestGapAnalysis } from "./ingest.js";
export type { SigNetClient, SigNetMemory, IngestOptions, IngestResult } from "./ingest.js";

export type {
	GHLOAuthTokens,
	GHLOAuthConfig,
	GHLLocation,
	GHLPipeline,
	GHLStage,
	GHLOpportunity,
	GHLContact,
	GHLTag,
	GHLWorkflow,
	GHLCalendar,
	GHLFunnel,
	GHLCustomField,
	GHLUser,
	GHLDiscoveryResult,
	GHLGap,
	GHLGapAnalysisResult,
	GHLConnectedAccount,
	GHLConnectorConfig,
	GapSeverity,
	GapCategory,
	GapFixAction,
	WorkflowStatus,
} from "./types.js";
