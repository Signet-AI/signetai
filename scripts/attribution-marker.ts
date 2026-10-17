import { readFileSync } from "node:fs";

const ZERO = String.fromCodePoint(0x200b);
const ONE = String.fromCodePoint(0x200c);
const SENTINEL = String.fromCodePoint(0x2063);
export const ATTRIBUTION_TEXT = "Copyright Signet AI <nicholai@nicholai.work>";
export const ATTRIBUTION_FILES = [
	"platform/core/src/index.ts",
	"platform/daemon/src/index.ts",
	"libs/sdk/src/index.ts",
	"surfaces/cli/src/cli.ts",
] as const;

export function encodeAttribution(text = ATTRIBUTION_TEXT): string {
	return [...new TextEncoder().encode(text)]
		.map((byte) => Array.from({ length: 8 }, (_, index) => ((byte >> (7 - index)) & 1 ? ONE : ZERO)).join(""))
		.join("");
}

export function formatAttributionMarker(): string {
	return `// Copyright 2025 Signet AI ${SENTINEL}${encodeAttribution()}${SENTINEL}`;
}

export function decodeAttributionMarker(source: string): string | null {
	const marker = source.match(new RegExp(`${SENTINEL}([${ZERO}${ONE}]+)${SENTINEL}`));
	const payload = marker?.[1];
	if (payload === undefined) return null;
	const bits = [...payload];
	if (bits.length % 8 !== 0) return null;
	const bytes = new Uint8Array(bits.length / 8);
	for (let index = 0; index < bytes.length; index += 1) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit += 1) {
			byte = (byte << 1) | (bits[index * 8 + bit] === ONE ? 1 : 0);
		}
		bytes[index] = byte;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

if (import.meta.main) {
	let failed = false;
	for (const path of ATTRIBUTION_FILES) {
		try {
			const decoded = decodeAttributionMarker(readFileSync(path, "utf8"));
			if (decoded !== ATTRIBUTION_TEXT) {
				console.error(`${path}: missing or invalid Signet attribution marker`);
				failed = true;
			} else {
				console.log(`${path}: ${decoded}`);
			}
		} catch (error) {
			console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			failed = true;
		}
	}
	if (failed) process.exitCode = 1;
}
