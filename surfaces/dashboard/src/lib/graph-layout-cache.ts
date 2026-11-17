import type { LayoutNode, LayoutPositions } from "./graph-layout";
const LAYOUT_VERSION = 1;
const DATABASE = "signet-graph-layout";
const STORE = "layouts";

export interface CachedLayout {
	readonly positions: LayoutPositions;
	readonly heat: number;
}

interface StoredLayout {
	readonly ids: readonly string[];
	readonly xy: Float32Array;
	readonly heat: number;
}
export async function layoutCacheKey(scope: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${LAYOUT_VERSION}:${scope}`));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request<T>(target: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		target.onsuccess = () => resolve(target.result);
		target.onerror = () => reject(target.error);
	});
}

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
	if (!database) {
		const opening = indexedDB.open(DATABASE, 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
		database = request(opening);
		database.catch(() => {
			database = undefined;
		});
	}
	return database;
}

function isStored(value: unknown): value is StoredLayout {
	if (typeof value !== "object" || value === null || !("ids" in value) || !("xy" in value) || !("heat" in value))
		return false;
	return (
		Array.isArray(value.ids) &&
		value.xy instanceof Float32Array &&
		value.xy.length === value.ids.length * 2 &&
		typeof value.heat === "number" &&
		Number.isFinite(value.heat)
	);
}

export async function readLayout(key: string): Promise<CachedLayout | undefined> {
	const db = await open();
	const stored: unknown = await request(db.transaction(STORE).objectStore(STORE).get(key));
	if (!isStored(stored)) return undefined;
	const positions = new Map<string, { x: number; y: number }>();
	for (const [index, id] of stored.ids.entries()) {
		const x = stored.xy[index * 2] ?? Number.NaN;
		const y = stored.xy[index * 2 + 1] ?? Number.NaN;
		if (typeof id === "string" && Number.isFinite(x) && Number.isFinite(y)) positions.set(id, { x, y });
	}
	return { positions, heat: stored.heat };
}

export async function writeLayout(key: string, nodes: readonly LayoutNode[], heat: number): Promise<void> {
	const xy = new Float32Array(nodes.length * 2);
	for (const [index, node] of nodes.entries()) {
		xy[index * 2] = node.x;
		xy[index * 2 + 1] = node.y;
	}
	const stored: StoredLayout = { ids: nodes.map((node) => node.id), xy, heat };
	const db = await open();
	const transaction = db.transaction(STORE, "readwrite");
	transaction.objectStore(STORE).put(stored, key);
	await new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}
