export interface LatestRequestGate {
	next(): number;
	isCurrent(id: number): boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
	let latest = 0;
	return {
		next(): number {
			latest += 1;
			return latest;
		},
		isCurrent(id: number): boolean {
			return id === latest;
		},
	};
}
