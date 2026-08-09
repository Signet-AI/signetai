/**
 * Keep the desktop constellation framing while applying only a modest,
 * capped pullback on tall narrow canvases.  A full bounding-sphere fit makes
 * the attenuated point cloud look invisible, so this deliberately favors
 * legibility over fitting every wireframe edge.
 */
const GRAPH_HOME_DESKTOP_DISTANCE = 520;
const GRAPH_HOME_MAX_TALL_DISTANCE = 620;
const TALL_CANVAS_DISTANCE_PER_RATIO = 180;

export function graphHomeCameraDistance(width: number, height: number): number {
	if (width <= 0 || height <= 0) return GRAPH_HOME_DESKTOP_DISTANCE;
	const extraDistance = Math.max(0, (height / width - 1) * TALL_CANVAS_DISTANCE_PER_RATIO);
	return Math.min(GRAPH_HOME_MAX_TALL_DISTANCE, Math.ceil(GRAPH_HOME_DESKTOP_DISTANCE + extraDistance));
}
