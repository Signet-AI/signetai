export type { ApiKeyCreateInput, ApiKeyRecord, CreatedApiKey } from "./api-keys";
export { createApiKey, extractApiKeyPrefix, isSignetApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";
export type { AuthConfig, AuthLoginConfig, PasswordLoginConfig } from "./config";
export { parseAuthConfig } from "./config";
export {
	createAuthMiddleware,
	getPeerAddress,
	isAuthOpenPath,
	requirePermission,
	requireRateLimit,
	requireScope,
} from "./middleware";
export { hashPassword, verifyPasswordHash, verifyPlainPassword } from "./password";

export { checkPermission, checkScope, PERMISSION_MATRIX } from "./policy";
export type { RateLimitConfig } from "./rate-limiter";
export { AuthRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter";
export { createToken, generateSecret, loadOrCreateSecret, verifyToken } from "./tokens";
export type {
	AuthMode,
	AuthResult,
	Permission,
	PolicyDecision,
	RateLimitCheck,
	TokenClaims,
	TokenRole,
	TokenScope,
} from "./types";
export { AUTH_MODES, PERMISSIONS, TOKEN_ROLES } from "./types";
