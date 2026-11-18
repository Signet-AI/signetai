export interface PaintView {
	readonly ratio: number;
	readonly panX: number;
	readonly panY: number;
	readonly zoom: number;
}

export const PAINT_SHAPES = ["circle", "square", "hexagon", "diamond", "triangle", "dot"] as const;
export type PaintShape = (typeof PAINT_SHAPES)[number];
export const DOT_SIDE = Math.sqrt(Math.PI);

export interface GraphPainter {
	begin(view: PaintView, width: number, height: number): void;
	lines(segments: Float64Array, count: number, color: string, alpha: number, width: number): void;
	highlight(
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		arrow: readonly number[] | undefined,
		color: string,
		alpha: number,
		width: number,
	): void;
	glyphs(
		points: Float64Array,
		count: number,
		color: string,
		alpha: number,
		outline: { readonly surface: string; readonly width: number } | undefined,
	): void;
	ring(x: number, y: number, radius: number, color: string, alpha: number, width: number): void;
	selection(x: number, y: number, reach: number, color: string, alpha: number): void;
	end(): void;
}

function hexagon(context: CanvasRenderingContext2D, x: number, y: number, r: number): void {
	for (let side = 0; side < 6; side++) {
		const angle = (Math.PI / 3) * side + Math.PI / 6;
		const px = x + Math.cos(angle) * r;
		const py = y + Math.sin(angle) * r;
		if (side === 0) context.moveTo(px, py);
		else context.lineTo(px, py);
	}
	context.closePath();
}

function glyphPath(context: CanvasRenderingContext2D, shape: PaintShape, x: number, y: number, r: number): void {
	if (shape === "dot") {
		const side = r * DOT_SIDE;
		context.rect(x - side / 2, y - side / 2, side, side);
	} else if (shape === "circle") {
		context.moveTo(x + r, y);
		context.arc(x, y, r, 0, Math.PI * 2);
	} else if (shape === "square") context.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
	else if (shape === "hexagon") hexagon(context, x, y, r * 1.1);
	else if (shape === "diamond") {
		context.moveTo(x, y - r * 1.25);
		context.lineTo(x + r * 1.25, y);
		context.lineTo(x, y + r * 1.25);
		context.lineTo(x - r * 1.25, y);
		context.closePath();
	} else {
		context.moveTo(x, y - r * 1.3);
		context.lineTo(x + r * 1.2, y + r * 0.8);
		context.lineTo(x - r * 1.2, y + r * 0.8);
		context.closePath();
	}
}

export function canvasPainter(context: CanvasRenderingContext2D): GraphPainter {
	let z = 1;
	return {
		begin(view, width, height) {
			z = view.zoom;
			context.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			context.save();
			context.translate(view.panX, view.panY);
			context.scale(z, z);
		},
		lines(segments, count, color, alpha, width) {
			context.lineWidth = width / z;
			context.strokeStyle = color;
			context.globalAlpha = alpha;
			context.beginPath();
			for (let index = 0; index < count; index++) {
				context.moveTo(segments[index * 4] ?? 0, segments[index * 4 + 1] ?? 0);
				context.lineTo(segments[index * 4 + 2] ?? 0, segments[index * 4 + 3] ?? 0);
			}
			context.stroke();
		},
		highlight(x0, y0, x1, y1, arrow, color, alpha, width) {
			context.strokeStyle = color;
			context.lineWidth = width / z;
			context.globalAlpha = alpha;
			context.beginPath();
			context.moveTo(x0, y0);
			context.lineTo(x1, y1);
			if (arrow) {
				context.moveTo(arrow[0] ?? 0, arrow[1] ?? 0);
				context.lineTo(arrow[2] ?? 0, arrow[3] ?? 0);
				context.lineTo(arrow[4] ?? 0, arrow[5] ?? 0);
			}
			context.stroke();
		},
		glyphs(points, count, color, alpha, outline) {
			context.globalAlpha = alpha;
			context.beginPath();
			for (let index = 0; index < count; index++) {
				const at = index * 4;
				glyphPath(
					context,
					PAINT_SHAPES[points[at + 3] ?? 0] ?? "circle",
					points[at] ?? 0,
					points[at + 1] ?? 0,
					points[at + 2] ?? 0,
				);
			}
			if (outline) {
				context.fillStyle = outline.surface;
				context.fill();
				context.strokeStyle = color;
				context.lineWidth = outline.width / z;
				context.stroke();
			} else {
				context.fillStyle = color;
				context.fill();
			}
		},
		ring(x, y, radius, color, alpha, width) {
			context.strokeStyle = color;
			context.globalAlpha = alpha;
			context.lineWidth = width / z;
			context.beginPath();
			context.arc(x, y, radius, 0, Math.PI * 2);
			context.stroke();
		},
		selection(x, y, reach, color, alpha) {
			context.globalAlpha = alpha;
			context.strokeStyle = color;
			context.lineWidth = 1 / z;
			context.setLineDash([3 / z, 3 / z]);
			context.beginPath();
			context.arc(x, y, reach, 0, Math.PI * 2);
			context.stroke();
			context.setLineDash([]);
			context.beginPath();
			for (let tick = 0; tick < 4; tick++) {
				const angle = (Math.PI / 2) * tick + Math.PI / 4;
				context.moveTo(x + Math.cos(angle) * (reach + 2 / z), y + Math.sin(angle) * (reach + 2 / z));
				context.lineTo(x + Math.cos(angle) * (reach + 6 / z), y + Math.sin(angle) * (reach + 6 / z));
			}
			context.stroke();
		},
		end() {
			context.restore();
		},
	};
}
