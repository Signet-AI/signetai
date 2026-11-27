export function nativeWorkerBootstrap(
	entry: string,
	registryModule: string,
	nativeAddons: readonly { readonly name: string; readonly contentBase64: string }[],
): string {
	return `import { registerNativeAssets } from ${JSON.stringify(registryModule)};\nregisterNativeAssets({ nativeAddons: ${JSON.stringify(nativeAddons)} });\nawait import(${JSON.stringify(entry)});\n`;
}
