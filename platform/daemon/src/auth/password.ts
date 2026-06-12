import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const PASSWORD_HASH_PREFIX = "pbkdf2-sha256";
const DEFAULT_ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function encodeBase64Url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Buffer {
	return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function constantTimeStringEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	if (bufA.length === 0) return true;
	return timingSafeEqual(bufA, bufB);
}

export function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): string {
	const salt = randomBytes(SALT_LENGTH);
	const digest = pbkdf2Sync(password, salt, iterations, KEY_LENGTH, "sha256");
	return `${PASSWORD_HASH_PREFIX}$${iterations}$${encodeBase64Url(salt)}$${encodeBase64Url(digest)}`;
}

export function verifyPasswordHash(password: string, storedHash: string): boolean {
	const parts = storedHash.split("$");
	if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_PREFIX) return false;

	const iterations = Number.parseInt(parts[1] ?? "", 10);
	if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;

	try {
		const salt = decodeBase64Url(parts[2] ?? "");
		const expected = decodeBase64Url(parts[3] ?? "");
		if (salt.length < 8 || expected.length !== KEY_LENGTH) return false;
		const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

export function verifyPlainPassword(password: string, expected: string): boolean {
	return constantTimeStringEqual(password, expected);
}
