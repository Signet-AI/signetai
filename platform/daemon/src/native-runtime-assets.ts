import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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

export interface EmbeddedNativeAddonAsset {
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
	readonly connectors?: readonly EmbeddedFileAsset[];
	readonly dashboard?: readonly EmbeddedDashboardAsset[];
	readonly skills?: readonly EmbeddedFileAsset[];
	readonly templates?: readonly EmbeddedFileAsset[];
	readonly workers?: readonly EmbeddedWorkerAsset[];
	readonly wasm?: readonly EmbeddedWasmAsset[];
	readonly nativeAddons?: readonly EmbeddedNativeAddonAsset[];
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
	const path = join(dir, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${hash}.mjs`);
	mkdirSync(dir, { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, Buffer.from(worker.contentBase64, "base64"));
	}
	return path;
}

// Materializes an embedded native `.node` addon so callers can `require()` it
// by absolute path -- some N-API packages (e.g. `@napi-rs/keyring`) don't
// survive Bun `--compile` bundling by package name.
export function materializeEmbeddedNativeAddon(name: string): string | null {
	const asset = (nativeRuntimeAssets().nativeAddons ?? []).find((a) => a.name === name);
	if (!asset) return null;

	const content = Buffer.from(asset.contentBase64, "base64");
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const dir = join(tmpdir(), "signet-native-addons");
	const path = join(dir, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${hash}.node`);
	mkdirSync(dir, { recursive: true });
	const prefix = `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`;
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".node") || entry === path.slice(dir.length + 1)) continue;
		try {
			unlinkSync(join(dir, entry));
		} catch {
			// A stale addon may still be loaded on Windows; retry next start.
		}
	}
	const valid = () =>
		existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) === hash;
	if (!valid()) {
		const tempDir = mkdtempSync(join(dir, ".tmp-"));
		const tempPath = join(tempDir, "addon.node");
		try {
			writeFileSync(tempPath, content, { flag: "wx" });
			// The temp is fully written before rename, so the loader never sees
			// partial content. Hash-keyed names mean we never replace a live file.
			// Concurrent identical publishers converge on one valid destination.
			let published = false;
			for (let attempt = 0; attempt < 2 && !published; attempt += 1) {
				try {
					renameSync(tempPath, path);
					published = true;
				} catch (error) {
					const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
					if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
					if (valid()) {
						published = true;
					} else if (attempt === 0) {
						// A corrupt destination is not loadable/locked; replace it once.
						try {
							unlinkSync(path);
						} catch {
							/* another publisher may be repairing it */
						}
					}
				}
			}
			if (!published) throw new Error(`Unable to publish native addon: ${path}`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
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

export function materializeEmbeddedAssetTree(kind: "connectors" | "skills" | "templates"): string | null {
	const assets = nativeRuntimeAssets()[kind] ?? [];
	if (assets.length === 0) return null;

	const sourceHash = createHash("sha256")
		.update(assets.map((asset) => `${asset.path}:${asset.contentBase64}:${asset.mode ?? ""}`).join("\n"))
		.digest("hex");
	const root = join(tmpdir(), `signet-native-${kind}`, sourceHash.slice(0, 16));
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
	if (kind === "connectors") {
		writeFileSync(join(root, ".signet-assets.json"), `${JSON.stringify({ kind, sourceHash }, null, 2)}\n`);
	}
	return root;
}
