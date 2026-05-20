import type { GraphCanvasNode } from "./types";

export class SpatialIndex {
	private readonly cellSize: number;
	private grid = new Map<string, GraphCanvasNode[]>();
	private lastHash = 0;

	constructor(cellSize = 160) {
		this.cellSize = cellSize;
	}

	rebuild(nodes: GraphCanvasNode[]): boolean {
		const hash = this.computeHash(nodes);
		if (hash === this.lastHash) return false;
		this.lastHash = hash;
		this.grid.clear();
		for (const node of nodes) {
			const key = this.keyFor(node.x, node.y);
			const bucket = this.grid.get(key) ?? [];
			bucket.push(node);
			this.grid.set(key, bucket);
		}
		return true;
	}

	queryPoint(worldX: number, worldY: number): GraphCanvasNode | null {
		const cx = Math.floor(worldX / this.cellSize);
		const cy = Math.floor(worldY / this.cellSize);
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const bucket = this.grid.get(`${cx + dx},${cy + dy}`);
				if (!bucket) continue;
				for (let i = bucket.length - 1; i >= 0; i--) {
					const node = bucket[i];
					if (node && this.hitTest(node, worldX, worldY)) return node;
				}
			}
		}
		return null;
	}

	private keyFor(x: number, y: number): string {
		return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
	}

	private hitTest(node: GraphCanvasNode, x: number, y: number): boolean {
		const half = Math.max(node.size * 0.5, 4);
		if (node.shape === "rect") return Math.abs(x - node.x) <= half && Math.abs(y - node.y) <= half;
		const dx = x - node.x;
		const dy = y - node.y;
		return dx * dx + dy * dy <= half * half;
	}

	private computeHash(nodes: GraphCanvasNode[]): number {
		let hash = nodes.length;
		for (const n of nodes) {
			let idHash = 0;
			for (let i = 0; i < n.id.length; i++) idHash = ((idHash << 5) - idHash + n.id.charCodeAt(i)) | 0;
			hash = (hash * 31 + idHash) | 0;
			hash = (hash * 31 + Math.round(n.x * 10)) | 0;
			hash = (hash * 31 + Math.round(n.y * 10)) | 0;
		}
		return hash;
	}
}
