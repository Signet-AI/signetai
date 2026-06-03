export const nativePlatforms = {
	"linux-x64": {
		binaryName: "signet",
		packageName: "signetai-linux-x64",
	},
	"linux-arm64": {
		binaryName: "signet",
		packageName: "signetai-linux-arm64",
	},
	"darwin-x64": {
		binaryName: "signet",
		packageName: "signetai-darwin-x64",
	},
	"darwin-arm64": {
		binaryName: "signet",
		packageName: "signetai-darwin-arm64",
	},
	"win32-x64": {
		binaryName: "signet.exe",
		packageName: "signetai-win32-x64",
	},
};

export function supportedNativePlatforms() {
	return Object.keys(nativePlatforms);
}

export function detectNativePlatform(platform = process.platform, arch = process.arch) {
	const os = platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
	const cpu = arch === "x64" || arch === "arm64" ? arch : null;
	if (!os || !cpu) {
		throw new Error(`Unsupported platform: ${platform}-${arch}`);
	}

	const platformKey = `${os}-${cpu}`;
	if (!nativePlatforms[platformKey]) {
		throw new Error(
			`Unsupported platform: ${platformKey}. Published Signet native packages: ${supportedNativePlatforms().join(", ")}`,
		);
	}

	return platformKey;
}
