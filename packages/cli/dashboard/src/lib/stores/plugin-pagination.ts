export function clampPage(index: number, itemCount: number, pageSize: number): number {
	if (pageSize <= 0 || itemCount <= 0) return 0;
	return Math.min(Math.max(index, 0), Math.max(0, Math.ceil(itemCount / pageSize) - 1));
}
