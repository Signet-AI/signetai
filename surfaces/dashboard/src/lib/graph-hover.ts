export class GraphHoverIntent {
	active: string | undefined;
	private candidate: string | undefined;
	private changedAt = 0;
	private pending = false;

	move(id: string | undefined, now: number): void {
		if (id === this.candidate) return;
		this.candidate = id;
		this.changedAt = now;
		this.pending = id !== this.active;
	}

	clear(): void {
		this.active = undefined;
		this.candidate = undefined;
		this.pending = false;
	}

	tick(now: number): boolean {
		if (this.pending && now - this.changedAt >= 120) {
			this.active = this.candidate;
			this.pending = false;
		}
		return this.pending;
	}
}
