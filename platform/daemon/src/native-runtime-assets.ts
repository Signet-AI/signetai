import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface EmbeddedDashboardAsset {
	readonly path: string;
	readonly contentType: string;
	readonly contentBase64: string;
}

export interface EmbeddedWorkerAsset {
	readonly name: string;
	readonly contentBase64: string;
}

export interface EmbeddedWasmAsset {
	readonly name: string;
	readonly contentBase64: string;
}

export interface EmbeddedFileAsset {
	readonly path: string;
	readonly contentBase64: string;
	readonly mode?: number;
}

export interface NativeRuntimeAssets {
	readonly dashboard?: readonly EmbeddedDashboardAsset[];
	readonly skills?: readonly EmbeddedFileAsset[];
	readonly templates?: readonly EmbeddedFileAsset[];
	readonly workers?: readonly EmbeddedWorkerAsset[];
	readonly wasm?: readonly EmbeddedWasmAsset[];
}

declare global {
	var __SIGNET_NATIVE_RUNTIME_ASSETS__: NativeRuntimeAssets | undefined;
	var __SIGNET_NATIVE_TRANSFORMERS_BINDINGS__: unknown;
}

export function registerNativeAssets(assets: NativeRuntimeAssets): void {
	globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ = assets;
}

export function registerNativeTransformersBindings(bindings: unknown): void {
	globalThis.__SIGNET_NATIVE_TRANSFORMERS_BINDINGS__ = bindings;
}

export function getNativeTransformersBindings(): unknown {
	return globalThis.__SIGNET_NATIVE_TRANSFORMERS_BINDINGS__;
}

function nativeRuntimeAssets(): NativeRuntimeAssets {
	return globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ ?? {};
}

export function getEmbeddedDashboardAssets(): readonly EmbeddedDashboardAsset[] {
	return nativeRuntimeAssets().dashboard ?? [];
}

export function resolveEmbeddedDashboardAsset(requestPath: string): EmbeddedDashboardAsset | null {
	const assets = getEmbeddedDashboardAssets();
	if (assets.length === 0) return null;

	const normalized = !requestPath.includes(".") || requestPath === "/" ? "/index.html" : requestPath;
	return assets.find((asset) => asset.path === normalized) ?? null;
}

export function resolveEmbeddedWorkerPath(name: string): string | null {
	const worker = (nativeRuntimeAssets().workers ?? []).find((asset) => asset.name === name);
	if (!worker) return null;

	const hash = createHash("sha256").update(worker.contentBase64).digest("hex").slice(0, 16);
	const dir = join(tmpdir(), "signet-native-workers");
	const path = join(dir, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${hash}.cjs`);
	mkdirSync(dir, { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, Buffer.from(worker.contentBase64, "base64"));
	}
	return path;
}

export function materializeEmbeddedWasmAssets(): string | null {
	const assets = nativeRuntimeAssets().wasm ?? [];
	if (assets.length === 0) return null;

	const hash = createHash("sha256")
		.update(assets.map((asset) => `${asset.name}:${asset.contentBase64}`).join("\n"))
		.digest("hex")
		.slice(0, 16);
	const dir = join(tmpdir(), "signet-native-wasm", hash);
	mkdirSync(dir, { recursive: true });
	for (const asset of assets) {
		const path = join(dir, asset.name.replace(/[/\\]/g, "_"));
		if (!existsSync(path)) {
			writeFileSync(path, Buffer.from(asset.contentBase64, "base64"));
		}
	}
	return dir;
}

export function materializeEmbeddedAssetTree(kind: "skills" | "templates"): string | null {
	const assets = nativeRuntimeAssets()[kind] ?? [];
	if (assets.length === 0) return null;

	const hash = createHash("sha256")
		.update(assets.map((asset) => `${asset.path}:${asset.contentBase64}:${asset.mode ?? ""}`).join("\n"))
		.digest("hex")
		.slice(0, 16);
	const root = join(tmpdir(), `signet-native-${kind}`, hash);
	mkdirSync(root, { recursive: true });
	for (const asset of assets) {
		const parts = asset.path.split(/[\\/]+/).filter(Boolean);
		if (parts.length === 0 || parts.includes("..")) continue;
		const path = join(root, ...parts);
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) {
			writeFileSync(path, Buffer.from(asset.contentBase64, "base64"));
			if (asset.mode !== undefined) chmodSync(path, asset.mode);
		}
	}
	return root;
}
