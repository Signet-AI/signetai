export class ViewportState {
	panX: number;
	panY: number;
	zoom: number;

	private velocityX = 0;
	private velocityY = 0;
	private readonly friction = 0.92;
	private targetZoom: number;
	private readonly zoomSpring = 0.075;
	private zoomAnchorX = 0;
	private zoomAnchorY = 0;
	private targetWorldX: number | null = null;
	private targetWorldY: number | null = null;
	private targetScreenX = 0;
	private targetScreenY = 0;
	private readonly panLerp = 0.075;

	private static readonly MIN_ZOOM = 0.1;
	private static readonly MAX_ZOOM = 6;

	constructor(initialPanX = 0, initialPanY = 0, initialZoom = 1) {
		this.panX = initialPanX;
		this.panY = initialPanY;
		this.zoom = clamp(initialZoom, ViewportState.MIN_ZOOM, ViewportState.MAX_ZOOM);
		this.targetZoom = this.zoom;
	}

	worldToScreen(wx: number, wy: number): { x: number; y: number } {
		return { x: wx * this.zoom + this.panX, y: wy * this.zoom + this.panY };
	}

	screenToWorld(sx: number, sy: number): { x: number; y: number } {
		return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
	}

	pan(dx: number, dy: number): void {
		this.panX += dx;
		this.panY += dy;
		this.clearFocusTarget();
	}

	releaseWithVelocity(vx: number, vy: number): void {
		this.velocityX = vx;
		this.velocityY = vy;
	}

	zoomImmediate(delta: number, anchorX: number, anchorY: number): void {
		const world = this.screenToWorld(anchorX, anchorY);
		this.zoom = clamp(this.zoom * delta, ViewportState.MIN_ZOOM, ViewportState.MAX_ZOOM);
		this.targetZoom = this.zoom;
		this.panX = anchorX - world.x * this.zoom;
		this.panY = anchorY - world.y * this.zoom;
		this.clearFocusTarget();
	}

	zoomTo(target: number, anchorX: number, anchorY: number): void {
		this.targetZoom = clamp(target, ViewportState.MIN_ZOOM, ViewportState.MAX_ZOOM);
		this.zoomAnchorX = anchorX;
		this.zoomAnchorY = anchorY;
		this.clearFocusTarget();
	}

	fitToNodes(
		nodes: Array<{ x: number; y: number; size: number }>,
		width: number,
		height: number,
		options: { maxZoom?: number; padding?: number } = {},
	): void {
		if (nodes.length === 0 || width <= 0 || height <= 0) return;
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const n of nodes) {
			const radius = n.size * 0.5;
			minX = Math.min(minX, n.x - radius);
			maxX = Math.max(maxX, n.x + radius);
			minY = Math.min(minY, n.y - radius);
			maxY = Math.max(maxY, n.y + radius);
		}
		const pad = options.padding ?? 0.14;
		const graphW = Math.max((maxX - minX) * (1 + pad * 2), 1);
		const graphH = Math.max((maxY - minY) * (1 + pad * 2), 1);
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		this.targetZoom = clamp(
			Math.min(width / graphW, height / graphH, options.maxZoom ?? 1.8),
			ViewportState.MIN_ZOOM,
			ViewportState.MAX_ZOOM,
		);
		this.targetWorldX = cx;
		this.targetWorldY = cy;
		this.targetScreenX = width / 2;
		this.targetScreenY = height / 2;
	}

	centerOn(worldX: number, worldY: number, width: number, height: number): void {
		this.targetWorldX = worldX;
		this.targetWorldY = worldY;
		this.targetScreenX = width / 2;
		this.targetScreenY = height / 2;
		this.targetZoom = this.zoom;
	}

	tick(): boolean {
		let moving = false;
		if (Math.abs(this.velocityX) > 0.5 || Math.abs(this.velocityY) > 0.5) {
			this.panX += this.velocityX;
			this.panY += this.velocityY;
			this.velocityX *= this.friction;
			this.velocityY *= this.friction;
			moving = true;
		} else {
			this.velocityX = 0;
			this.velocityY = 0;
		}
		const targetWorldX = this.targetWorldX;
		const targetWorldY = this.targetWorldY;
		if (targetWorldX !== null && targetWorldY !== null) {
			const zoomSettled = this.stepZoom();
			const targetPanX = this.targetScreenX - targetWorldX * this.zoom;
			const targetPanY = this.targetScreenY - targetWorldY * this.zoom;
			const panSettled = this.stepPan(targetPanX, targetPanY);
			if (!zoomSettled || !panSettled) moving = true;
			else this.clearFocusTarget();
			return moving;
		}
		if (!this.stepZoom()) {
			const world = this.screenToWorld(this.zoomAnchorX, this.zoomAnchorY);
			this.panX = this.zoomAnchorX - world.x * this.zoom;
			this.panY = this.zoomAnchorY - world.y * this.zoom;
			moving = true;
		}
		return moving;
	}

	private stepZoom(): boolean {
		const zoomDiff = this.targetZoom - this.zoom;
		if (Math.abs(zoomDiff) > 0.001) {
			this.zoom += zoomDiff * this.zoomSpring;
			return false;
		}
		this.zoom = this.targetZoom;
		return true;
	}

	private stepPan(targetPanX: number, targetPanY: number): boolean {
		const dx = targetPanX - this.panX;
		const dy = targetPanY - this.panY;
			if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
				this.panX += dx * this.panLerp;
				this.panY += dy * this.panLerp;
			return false;
			}
		this.panX = targetPanX;
		this.panY = targetPanY;
		return true;
	}

	private clearFocusTarget(): void {
		this.targetWorldX = null;
		this.targetWorldY = null;
	}
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}
