export interface ScopedHeadValue {
	readonly generated: true;
	readonly status: "current" | "stale";
	readonly content: string | null;
}

interface Entry {
	readonly fence: string;
	readonly value: ScopedHeadValue;
	readonly bytes: number;
}

export class ScopedHeadCache {
	private readonly entries = new Map<string, Entry>();
	private bytes = 0;
	constructor(private readonly onRemove: (key: string) => void) {}

	get(key: string, fence: string): ScopedHeadValue | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		if (entry.fence !== fence) {
			this.remove(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return { ...entry.value };
	}

	set(key: string, fence: string, value: ScopedHeadValue): void {
		this.remove(key);
		const bytes = Buffer.byteLength(value.content ?? "") + Buffer.byteLength(key) + Buffer.byteLength(fence);
		if (bytes > 262144) return;
		while (this.entries.size >= 64 || this.bytes + bytes > 16777216) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.remove(oldest);
		}
		this.entries.set(key, { fence, value: { ...value }, bytes });
		this.bytes += bytes;
	}

	invalidate(key: string): void {
		this.remove(key);
	}

	clear(): void {
		for (const key of this.entries.keys()) this.remove(key);
	}

	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.bytes -= entry.bytes;
		this.entries.delete(key);
		this.onRemove(key);
	}
}
