let incomplete = true;

export function setFtsIndexIncomplete(value: boolean): void {
	incomplete = value;
}

export function isFtsIndexIncomplete(): boolean {
	return incomplete;
}

export function resetFtsIndexState(): void {
	incomplete = true;
}
