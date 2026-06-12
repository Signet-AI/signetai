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
export { AUTH_MODES, TOKEN_ROLES, PERMISSIONS } from "./types";

export { generateSecret, loadOrCreateSecret, createToken, verifyToken } from "./tokens";
export { createApiKey, extractApiKeyPrefix, isSignetApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";
export type { ApiKeyCreateInput, ApiKeyRecord, CreatedApiKey } from "./api-keys";
export { hashPassword, verifyPasswordHash, verifyPlainPassword } from "./password";

export { checkPermission, checkScope, PERMISSION_MATRIX } from "./policy";

export { AuthRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter";
export type { RateLimitConfig } from "./rate-limiter";

export { parseAuthConfig } from "./config";
export type { AuthConfig, AuthLoginConfig, PasswordLoginConfig } from "./config";

export {
	createAuthMiddleware,
	getPeerAddress,
	isAuthOpenPath,
	requirePermission,
	requireScope,
	requireRateLimit,
} from "./middleware";
