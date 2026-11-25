import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const pairSchema = z.object({
	accessToken: z.string().regex(/^sig_ses_ses_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/),
	refreshToken: z.string().regex(/^sig_ref_ses_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/),
	accessExpiresAt: z.string(),
	refreshExpiresAt: z.string(),
});
export type RefreshPair = z.infer<typeof pairSchema>;
const entrySchema = z.object({
	previousHash: z.string().regex(/^[a-f0-9]{64}$/),
	expiresAt: z.number().int(),
	ciphertext: z.string().min(1).max(4096),
});
const stateSchema = z.array(entrySchema).max(64);
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function entries(raw: string) {
	if (raw.length > 262144) throw new Error("Refresh retry state exceeds its bound");
	return stateSchema.parse(JSON.parse(raw));
}
function aad(sessionId: string, hash: string, expiresAt: number): Buffer {
	return Buffer.from(`${sessionId}:${hash}:${expiresAt}`);
}
export class RefreshRetryCapacityError extends Error {}
export function appendRefreshRetry(
	raw: string,
	token: string,
	sessionId: string,
	previousHash: string,
	pair: RefreshPair,
	now = Date.now(),
): string {
	const live = entries(raw).filter((entry) => entry.expiresAt > now);
	if (live.length >= 64) throw new RefreshRetryCapacityError("Refresh retry capacity reached");
	const expiresAt = now + 86400_000;
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(token).digest(), nonce);
	cipher.setAAD(aad(sessionId, previousHash, expiresAt));
	const body = Buffer.concat([cipher.update(JSON.stringify(pairSchema.parse(pair)), "utf8"), cipher.final()]);
	return JSON.stringify([
		...live,
		{ previousHash, expiresAt, ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url") },
	]);
}
export function replayRefreshRetry(
	raw: string,
	token: string,
	sessionId: string,
	currentAccessHash: string,
	currentRefreshHash: string,
	now = Date.now(),
): RefreshPair | null {
	const live = entries(raw);
	let credential = token;
	for (let attempt = 0; attempt < 64; attempt++) {
		const hash = digest(credential.slice(-43));
		const entry = live.find((item) => item.previousHash === hash && item.expiresAt > now);
		if (!entry) return null;
		const sealed = Buffer.from(entry.ciphertext, "base64url");
		if (sealed.length < 29) throw new Error("Invalid refresh retry ciphertext");
		const cipher = createDecipheriv(
			"aes-256-gcm",
			createHash("sha256").update(credential).digest(),
			sealed.subarray(0, 12),
		);
		cipher.setAAD(aad(sessionId, hash, entry.expiresAt));
		cipher.setAuthTag(sealed.subarray(12, 28));
		const pair = pairSchema.parse(
			JSON.parse(Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString("utf8")),
		);
		if (!pair.refreshToken.startsWith(`sig_ref_${sessionId}_`) || !pair.accessToken.startsWith(`sig_ses_${sessionId}_`))
			throw new Error("Refresh retry session mismatch");
		if (
			digest(pair.refreshToken.slice(-43)) === currentRefreshHash &&
			digest(pair.accessToken.slice(-43)) === currentAccessHash
		)
			return pair;
		credential = pair.refreshToken;
	}
	throw new Error("Refresh retry chain exceeds its bound");
}
