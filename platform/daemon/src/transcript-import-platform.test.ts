import { expect, test } from "bun:test";
import {
	assertTranscriptImportPlatformSupported,
	getTranscriptImportPlatformError,
	TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS,
	TRANSCRIPT_IMPORT_UNSUPPORTED_PLATFORM_CODE,
	UnsupportedTranscriptImportPlatformError,
} from "./transcript-import-safe-fs";

test("rejects unsupported transcript filesystem platforms with a structured error", () => {
	const error = getTranscriptImportPlatformError("win32");
	expect(error).toBeInstanceOf(UnsupportedTranscriptImportPlatformError);
	expect(error).toMatchObject({
		name: "UNSUPPORTED_TRANSCRIPT_IMPORT_PLATFORM",
		code: TRANSCRIPT_IMPORT_UNSUPPORTED_PLATFORM_CODE,
		platform: "win32",
		supportedPlatforms: ["linux", "darwin"],
	});
	expect(error?.message).toContain("durable transcript imports are unavailable on win32");
	expect(() => assertTranscriptImportPlatformSupported("win32")).toThrow(
		"durable transcript imports are unavailable on win32",
	);
});

test("allows platforms with descriptor-relative transcript safeguards", () => {
	expect(TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS).toEqual(["linux", "darwin"]);
	for (const platform of TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS) {
		expect(getTranscriptImportPlatformError(platform)).toBeUndefined();
		expect(() => assertTranscriptImportPlatformSupported(platform)).not.toThrow();
	}
});

test("the host platform is either descriptor-safe or explicitly gated", () => {
	const error = getTranscriptImportPlatformError(process.platform);
	if (process.platform === "win32") {
		expect(error).toMatchObject({
			name: "UNSUPPORTED_TRANSCRIPT_IMPORT_PLATFORM",
			code: TRANSCRIPT_IMPORT_UNSUPPORTED_PLATFORM_CODE,
			platform: "win32",
		});
	} else {
		expect(error).toBeUndefined();
	}
});
