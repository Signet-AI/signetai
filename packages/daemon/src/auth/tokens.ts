/**
 * Token creation and verification using HMAC-SHA256.
 * No external dependencies — uses Web Crypto API only.
 *
 * Token format: {base64url(payload)}.{base64url(hmac)}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import type { AuthResult, TokenClaims, TokenRole, TokenScope } from "./types";

function base64urlEncode(data: Buffer | Uint8Array): string {
	return Buffer.from(data)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(padded, "base64");
}

export function generateSecret(): Buffer {
	return randomBytes(32);
}

export function loadOrCreateSecret(secretPath: string): Buffer {
	if (existsSync(secretPath)) {
		return readFileSync(secretPath);
	}
	const dir = dirname(secretPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const secret = generateSecret();
	writeFileSync(secretPath, secret, { mode: 0o600 });
	return secret;
}

function sign(secret: Buffer, payload: string): Buffer {
	return createHmac("sha256", secret).update(payload).digest();
}

export function createToken(
	secret: Buffer,
	claims: {
		readonly sub: string;
		readonly scope: TokenScope;
		readonly role: TokenRole;
	},
	ttlSeconds: number,
): string {
	const now = Math.floor(Date.now() / 1000);
	const fullClaims: TokenClaims = {
		sub: claims.sub,
		scope: claims.scope,
		role: claims.role,
		iat: now,
		exp: now + ttlSeconds,
	};
	const payloadStr = JSON.stringify(fullClaims);
	const payloadB64 = base64urlEncode(Buffer.from(payloadStr, "utf-8"));
	const signature = sign(secret, payloadB64);
	return `${payloadB64}.${base64urlEncode(signature)}`;
}

export function verifyToken(secret: Buffer, token: string): AuthResult {
	const dotIndex = token.indexOf(".");
	if (dotIndex < 0 || dotIndex === token.length - 1) {
		return { authenticated: false, claims: null, error: "malformed token" };
	}

	const payloadB64 = token.slice(0, dotIndex);
	const sigB64 = token.slice(dotIndex + 1);

	const expectedSig = sign(secret, payloadB64);
	const actualSig = base64urlDecode(sigB64);

	if (
		expectedSig.length !== actualSig.length ||
		!expectedSig.equals(actualSig)
	) {
		return { authenticated: false, claims: null, error: "invalid signature" };
	}

	let claims: TokenClaims;
	try {
		const raw = base64urlDecode(payloadB64).toString("utf-8");
		claims = JSON.parse(raw) as TokenClaims;
	} catch {
		return { authenticated: false, claims: null, error: "malformed payload" };
	}

	if (typeof claims.exp !== "number" || typeof claims.iat !== "number") {
		return { authenticated: false, claims: null, error: "missing timestamps" };
	}

	const now = Math.floor(Date.now() / 1000);
	if (now >= claims.exp) {
		return { authenticated: false, claims: null, error: "token expired" };
	}

	return { authenticated: true, claims };
}
