import { supportedNativePlatforms } from "../dist/signetai/bin/native-platforms.js";

const supported = supportedNativePlatforms();

export function compileTargetFor(targetPlatform: string): string {
	if (!supported.includes(targetPlatform)) {
		throw new Error(`Unsupported native compile platform: ${targetPlatform}`);
	}

	const bunPlatform = targetPlatform.startsWith("win32-")
		? `windows-${targetPlatform.slice("win32-".length)}`
		: targetPlatform;
	return `bun-${bunPlatform}`;
}

export function nativeBinaryArtifactNames(): string[] {
	return [
		"signet",
		"signet.exe",
		...supported.map((platform) => `signet-${platform}${platform.startsWith("win32-") ? ".exe" : ""}`),
	];
}
