import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import type { AuthResult, Permission, TokenClaims, TokenRole, TokenScope } from "./types";
import { PERMISSIONS, TOKEN_ROLES } from "./types";

const API_KEY_PREFIX = "sig_sk_";
const DEFAULT_CONNECTOR_PERMISSIONS: readonly Permission[] = ["recall", "remember", "documents"];

export interface ApiKeyCreateInput {
	readonly name: string;
	readonly role?: TokenRole;
	readonly scope?: TokenScope;
	readonly permissions?: readonly Permission[];
	readonly connector?: string;
	readonly harness?: string;
	readonly agentId?: string;
	readonly allowedProjects?: readonly string[];
	readonly expiresAt?: string | null;
}

export interface ApiKeyRecord {
	readonly id: string;
	readonly prefix: string;
	readonly name: string;
	readonly role: TokenRole;
	readonly scope: TokenScope;
	readonly permissions: readonly Permission[];
	readonly connector: string | null;
	readonly harness: string | null;
	readonly agentId: string | null;
	readonly allowedProjects: readonly string[];
	readonly createdAt: string;
	readonly lastUsedAt: string | null;
	readonly revokedAt: string | null;
	readonly expiresAt: string | null;
}

export interface CreatedApiKey extends ApiKeyRecord {
	readonly key: string;
}

interface ApiKeyRow {
	readonly id: string;
	readonly prefix: string;
	readonly name: string;
	readonly key_hash: string;
	readonly role: string;
	readonly scope_json: string;
	readonly permissions_json: string;
	readonly connector: string | null;
	readonly harness: string | null;
	readonly agent_id: string | null;
	readonly allowed_projects_json: string | null;
	readonly created_at: string;
	readonly last_used_at: string | null;
	readonly revoked_at: string | null;
	readonly expires_at: string | null;
}

function base64url(bytes: Buffer): string {
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hashApiKey(key: string): string {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(key, salt, 32).toString("hex");
	return `scrypt:${salt}:${hash}`;
}

function verifyApiKeyHash(storedHash: string, token: string): boolean {
	const [algorithm, salt, hash] = storedHash.split(":");
	if (algorithm === "scrypt" && salt && hash) {
		const expected = Buffer.from(hash, "hex");
		const actual = scryptSync(token, salt, expected.length).toString("hex");
		const actualBuffer = Buffer.from(actual, "hex");
		return expected.length === actualBuffer.length && timingSafeEqual(expected, actualBuffer);
	}

	return false;
}

function safeJsonObject(raw: string): TokenScope {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		return {
			...(typeof record.project === "string" ? { project: record.project } : {}),
			...(typeof record.agent === "string" ? { agent: record.agent } : {}),
			...(typeof record.user === "string" ? { user: record.user } : {}),
		};
	} catch {
		return {};
	}
}

function safeStringArray(raw: string | null): readonly string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	} catch {
		return [];
	}
}

function normalizePermissions(values: readonly string[] | undefined, fallback: readonly Permission[]): readonly Permission[] {
	if (!values) return fallback;
	const normalized = values.filter((value): value is Permission => (PERMISSIONS as readonly string[]).includes(value));
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeRole(role: unknown): TokenRole {
	return typeof role === "string" && (TOKEN_ROLES as readonly string[]).includes(role) ? (role as TokenRole) : "agent";
}

function normalizeOptionalString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return null;
	const date = new Date(trimmed);
	if (Number.isNaN(date.getTime())) throw new Error("expiresAt must be a valid ISO timestamp");
	return date.toISOString();
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
	return {
		id: row.id,
		prefix: row.prefix,
		name: row.name,
		role: normalizeRole(row.role),
		scope: safeJsonObject(row.scope_json),
		permissions: normalizePermissions(safeStringArray(row.permissions_json), []),
		connector: row.connector,
		harness: row.harness,
		agentId: row.agent_id,
		allowedProjects: safeStringArray(row.allowed_projects_json),
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		expiresAt: row.expires_at,
	};
}

function queryByIdOrPrefix(db: ReadDb | WriteDb, idOrPrefix: string): ApiKeyRow | undefined {
	return db
		.prepare(
			`SELECT id, prefix, name, key_hash, role, scope_json, permissions_json, connector, harness,
			        agent_id, allowed_projects_json, created_at, last_used_at, revoked_at, expires_at
			   FROM api_keys
			  WHERE id = ? OR prefix = ?
			  LIMIT 1`,
		)
		.get(idOrPrefix, idOrPrefix) as ApiKeyRow | undefined;
}

export function isSignetApiKey(token: string): boolean {
	return token.startsWith(API_KEY_PREFIX);
}

export function extractApiKeyPrefix(token: string): string | null {
	if (!isSignetApiKey(token)) return null;
	const rest = token.slice(API_KEY_PREFIX.length);
	const sep = rest.indexOf("_");
	if (sep <= 0) return null;
	const prefix = rest.slice(0, sep);
	return /^[A-Za-z0-9]+$/.test(prefix) ? prefix : null;
}

export function createApiKey(accessor: DbAccessor, input: ApiKeyCreateInput): CreatedApiKey {
	const name = normalizeOptionalString(input.name);
	if (!name) throw new Error("name is required");
	const id = `key_${base64url(randomBytes(12))}`;
	const prefix = randomBytes(6).toString("hex");
	const secret = base64url(randomBytes(32));
	const key = `${API_KEY_PREFIX}${prefix}_${secret}`;
	const now = new Date().toISOString();
	const role = input.role ?? "agent";
	const connector = normalizeOptionalString(input.connector);
	const harness = normalizeOptionalString(input.harness) ?? connector;
	const permissions = normalizePermissions(input.permissions, connector || harness ? DEFAULT_CONNECTOR_PERMISSIONS : []);
	const expiresAt = normalizeIsoTimestamp(input.expiresAt);

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO api_keys
			   (id, prefix, name, key_hash, role, scope_json, permissions_json, connector, harness,
			    agent_id, allowed_projects_json, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			prefix,
			name,
			hashApiKey(key),
			role,
			JSON.stringify(input.scope ?? {}),
			JSON.stringify(permissions),
			connector,
			harness,
			normalizeOptionalString(input.agentId),
			input.allowedProjects?.length ? JSON.stringify(input.allowedProjects) : null,
			now,
			expiresAt,
		);
	});

	return {
		id,
		prefix,
		name,
		role,
		scope: input.scope ?? {},
		permissions,
		connector,
		harness,
		agentId: normalizeOptionalString(input.agentId),
		allowedProjects: input.allowedProjects ?? [],
		createdAt: now,
		lastUsedAt: null,
		revokedAt: null,
		expiresAt,
		key,
	};
}

export function listApiKeys(accessor: DbAccessor): readonly ApiKeyRecord[] {
	return accessor.withReadDb((db) =>
		(
			db
				.prepare(
					`SELECT id, prefix, name, key_hash, role, scope_json, permissions_json, connector, harness,
					        agent_id, allowed_projects_json, created_at, last_used_at, revoked_at, expires_at
					   FROM api_keys
					  ORDER BY created_at DESC`,
				)
				.all() as unknown as ApiKeyRow[]
		).map(rowToRecord),
	);
}

export function revokeApiKey(accessor: DbAccessor, idOrPrefix: string): ApiKeyRecord | null {
	const now = new Date().toISOString();
	return accessor.withWriteTx((db) => {
		const row = queryByIdOrPrefix(db, idOrPrefix);
		if (!row) return null;
		db.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, row.id);
		return rowToRecord({ ...row, revoked_at: row.revoked_at ?? now });
	});
}

export function verifyApiKey(accessor: DbAccessor, token: string): AuthResult {
	const prefix = extractApiKeyPrefix(token);
	if (!prefix) return { authenticated: false, claims: null, error: "malformed api key" };
	const now = new Date().toISOString();

	return accessor.withWriteTx((db) => {
		const row = db
			.prepare(
				`SELECT id, prefix, name, key_hash, role, scope_json, permissions_json, connector, harness,
				        agent_id, allowed_projects_json, created_at, last_used_at, revoked_at, expires_at
				   FROM api_keys
				  WHERE prefix = ?
				  LIMIT 1`,
			)
			.get(prefix) as ApiKeyRow | undefined;
		if (!row) return { authenticated: false, claims: null, error: "invalid api key" };

		if (!verifyApiKeyHash(row.key_hash, token)) {
			return { authenticated: false, claims: null, error: "invalid api key" };
		}
		if (row.revoked_at) return { authenticated: false, claims: null, error: "api key revoked" };
		if (row.expires_at && row.expires_at <= now) return { authenticated: false, claims: null, error: "api key expired" };

		db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);
		const role = normalizeRole(row.role);
		const scope = safeJsonObject(row.scope_json);
		const iat = Math.floor(new Date(row.created_at).getTime() / 1000);
		const exp = row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : 2 ** 31 - 1;
		const permissions = normalizePermissions(safeStringArray(row.permissions_json), []);
		const claims: TokenClaims = {
			sub: `api-key:${row.id}`,
			role,
			scope,
			iat,
			exp,
			...(permissions.length > 0 ? { permissions } : {}),
		};
		return { authenticated: true, claims };
	});
}
