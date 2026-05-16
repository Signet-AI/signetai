import type { SpatialIndex } from "./hit-test";
import type { GraphCanvasNode } from "./types";
import type { ViewportState } from "./viewport";

interface InputCallbacks {
	onNodeHover: (node: GraphCanvasNode | null) => void;
	onNodeClick: (node: GraphCanvasNode | null) => void;
	onNodeDragStart: (node: GraphCanvasNode) => void;
	onNodeDragEnd: (node: GraphCanvasNode) => void;
	onNodeDoubleClick: (node: GraphCanvasNode | null) => void;
	onRequestRender: () => void;
}

export class GraphInputHandler {
	private isPanning = false;
	private draggingNode: GraphCanvasNode | null = null;
	private didDrag = false;
	private lastX = 0;
	private lastY = 0;
	private currentHoverId: string | null = null;
	private posHistory: Array<{ x: number; y: number; t: number }> = [];

	private readonly mouseDown = this.onMouseDown.bind(this);
	private readonly mouseMove = this.onMouseMove.bind(this);
	private readonly mouseUp = this.onMouseUp.bind(this);
	private readonly click = this.onClick.bind(this);
	private readonly doubleClick = this.onDoubleClick.bind(this);
	private readonly wheel = this.onWheel.bind(this);

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly viewport: ViewportState,
		private readonly spatial: SpatialIndex,
		private readonly callbacks: InputCallbacks,
	) {
		canvas.addEventListener("mousedown", this.mouseDown);
		canvas.addEventListener("mousemove", this.mouseMove);
		canvas.addEventListener("mouseup", this.mouseUp);
		canvas.addEventListener("mouseleave", this.mouseUp);
		canvas.addEventListener("click", this.click);
		canvas.addEventListener("dblclick", this.doubleClick);
		canvas.addEventListener("wheel", this.wheel, { passive: false });
	}

	destroy(): void {
		this.canvas.removeEventListener("mousedown", this.mouseDown);
		this.canvas.removeEventListener("mousemove", this.mouseMove);
		this.canvas.removeEventListener("mouseup", this.mouseUp);
		this.canvas.removeEventListener("mouseleave", this.mouseUp);
		this.canvas.removeEventListener("click", this.click);
		this.canvas.removeEventListener("dblclick", this.doubleClick);
		this.canvas.removeEventListener("wheel", this.wheel);
	}

	getDraggingNode(): GraphCanvasNode | null {
		return this.draggingNode;
	}

	private canvasPoint(e: MouseEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private nodeAt(x: number, y: number): GraphCanvasNode | null {
		const world = this.viewport.screenToWorld(x, y);
		return this.spatial.queryPoint(world.x, world.y);
	}

	private onMouseDown(e: MouseEvent): void {
		const point = this.canvasPoint(e);
		const node = this.nodeAt(point.x, point.y);
		this.lastX = point.x;
		this.lastY = point.y;
		this.posHistory = [{ ...point, t: performance.now() }];
		this.didDrag = false;
		if (node) {
			this.draggingNode = node;
			node.fx = node.x;
			node.fy = node.y;
			this.callbacks.onNodeDragStart(node);
			this.canvas.style.cursor = "grabbing";
			return;
		}
		this.isPanning = true;
		this.canvas.style.cursor = "grabbing";
	}

	private onMouseMove(e: MouseEvent): void {
		const point = this.canvasPoint(e);
		if (this.draggingNode) {
			const world = this.viewport.screenToWorld(point.x, point.y);
			this.draggingNode.x = world.x;
			this.draggingNode.y = world.y;
			this.draggingNode.fx = world.x;
			this.draggingNode.fy = world.y;
			this.didDrag = true;
			this.callbacks.onRequestRender();
			return;
		}
		if (this.isPanning) {
			this.viewport.pan(point.x - this.lastX, point.y - this.lastY);
			this.lastX = point.x;
			this.lastY = point.y;
			this.didDrag = true;
			const now = performance.now();
			this.posHistory.push({ ...point, t: now });
			if (this.posHistory.length > 4) this.posHistory.shift();
			this.callbacks.onRequestRender();
			return;
		}
		const node = this.nodeAt(point.x, point.y);
		const id = node?.id ?? null;
		if (id !== this.currentHoverId) {
			this.currentHoverId = id;
			this.callbacks.onNodeHover(node);
			this.canvas.style.cursor = node ? "grab" : "default";
			this.callbacks.onRequestRender();
		}
	}

	private onMouseUp(): void {
		if (this.draggingNode) {
			const node = this.draggingNode;
			node.fx = null;
			node.fy = null;
			this.draggingNode = null;
			this.callbacks.onNodeDragEnd(node);
			this.canvas.style.cursor = this.currentHoverId ? "grab" : "default";
			return;
		}
		if (!this.isPanning) return;
		this.isPanning = false;
		const first = this.posHistory[0];
		const last = this.posHistory[this.posHistory.length - 1];
		if (first && last) {
			const dt = last.t - first.t;
			if (dt > 0 && dt < 200)
				this.viewport.releaseWithVelocity(((last.x - first.x) / dt) * 16, ((last.y - first.y) / dt) * 16);
		}
		this.canvas.style.cursor = "default";
		this.callbacks.onRequestRender();
	}

	private onClick(e: MouseEvent): void {
		if (this.didDrag) return;
		const point = this.canvasPoint(e);
		this.callbacks.onNodeClick(this.nodeAt(point.x, point.y));
	}

	private onDoubleClick(e: MouseEvent): void {
		const point = this.canvasPoint(e);
		this.callbacks.onNodeDoubleClick(this.nodeAt(point.x, point.y));
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		const point = this.canvasPoint(e);
		if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			this.viewport.pan(-e.deltaX, 0);
		} else {
			const delta = normalizeWheelDelta(e);
			this.viewport.zoomImmediate(Math.max(0.86, Math.min(1.16, Math.exp(-delta * 0.0011))), point.x, point.y);
		}
		this.callbacks.onRequestRender();
	}
}

function normalizeWheelDelta(e: WheelEvent): number {
	if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
	if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * 400;
	return e.deltaY;
}
