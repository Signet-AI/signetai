import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
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
	const valid = () =>
		existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) === hash;
	if (!valid()) {
		const tempDir = mkdtempSync(join(dir, ".tmp-"));
		const tempPath = join(tempDir, "addon.node");
		try {
			writeFileSync(tempPath, content, { flag: "wx" });
			// rename() is atomic when it succeeds. On Windows, transient sharing
			// violations can reject replacement while another loader has the file
			// open, so retry the same atomic replace without unlinking the live
			// destination. This preserves the old valid file until replacement
			// succeeds and makes a crash leave either the old or new file.
			let published = false;
			for (let attempt = 0; attempt < 5 && !published; attempt += 1) {
				try {
					renameSync(tempPath, path);
					published = true;
				} catch (error) {
					const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
					if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
					if (attempt < 4) Bun.sleepSync(5 * (attempt + 1));
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
