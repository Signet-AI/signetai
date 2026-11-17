import { randomUUID } from "node:crypto";
import type { Dir } from "node:fs";
import { opendir } from "node:fs/promises";

const PREFIX = "\0signet-directory:";

export interface NativeSourceDirectoryCursor {
	readonly path: string;
	readonly after: string | null;
	readonly token: string;
	readonly read: number;
}

export function directoryCursor(value: string): NativeSourceDirectoryCursor | null {
	if (!value.startsWith(PREFIX)) return null;
	const cursor: unknown = JSON.parse(value.slice(PREFIX.length));
	if (
		typeof cursor !== "object" ||
		cursor === null ||
		!("path" in cursor) ||
		typeof cursor.path !== "string" ||
		!("after" in cursor) ||
		(cursor.after !== null && typeof cursor.after !== "string") ||
		!("token" in cursor) ||
		typeof cursor.token !== "string" ||
		!("read" in cursor) ||
		typeof cursor.read !== "number" ||
		!Number.isSafeInteger(cursor.read) ||
		cursor.read < 0
	)
		throw new Error("Invalid native source directory checkpoint");
	return { path: cursor.path, after: cursor.after, token: cursor.token, read: cursor.read };
}

export function encodeDirectoryCursor(cursor: NativeSourceDirectoryCursor): string {
	return PREFIX + JSON.stringify(cursor);
}

interface Run {
	readonly names: readonly string[];
	index: number;
}

export class NativeSourceDirectory {
	readonly token = randomUUID();
	readonly path: string;
	read = 0;
	private directory: Dir | null;
	private readonly runs: (readonly string[])[] = [];
	private heap: Run[] = [];
	private after: string | null;

	private constructor(path: string, after: string | null, directory: Dir) {
		this.path = path;
		this.after = after;
		this.directory = directory;
	}

	static async open(path: string, after: string | null): Promise<NativeSourceDirectory> {
		return new NativeSourceDirectory(path, after, await opendir(path));
	}

	get complete(): boolean {
		return this.directory === null;
	}

	get hasNext(): boolean {
		return this.heap.length > 0;
	}

	async enumerate(
		limit: number,
		deadline: number,
		accepts: (entry: import("node:fs").Dirent) => boolean,
	): Promise<number> {
		const names: string[] = [];
		let count = 0;
		while (this.directory !== null && count < limit && (count === 0 || performance.now() < deadline)) {
			const entry = await this.directory.read();
			if (entry === null) {
				await this.close();
				break;
			}
			count++;
			this.read++;
			if ((this.after === null || entry.name > this.after) && accepts(entry)) names.push(entry.name);
		}
		if (names.length > 0) this.runs.push(names.sort());
		if (this.complete) this.seek(this.after);
		return count;
	}

	private seek(after: string | null): void {
		this.heap = [];
		for (const names of this.runs) {
			let low = 0;
			let high = names.length;
			while (low < high) {
				const mid = Math.floor((low + high) / 2);
				if (after !== null && (names[mid] ?? "") <= after) low = mid + 1;
				if (after === null || (names[mid] ?? "") > after) high = mid;
			}
			if (low < names.length) this.heap.push({ names, index: low });
		}
		this.heap.sort((left, right) => this.compare(left, right));
		this.after = after;
	}

	private compare(left: Run, right: Run): number {
		const a = left.names[left.index] ?? "";
		const b = right.names[right.index] ?? "";
		return a < b ? -1 : Number(a > b);
	}

	next(after: string | null): string | null {
		if (after !== this.after) this.seek(after);
		const first = this.heap[0];
		if (first === undefined) return null;
		const name = first.names[first.index] ?? null;
		first.index++;
		if (first.index === first.names.length) {
			const last = this.heap.pop();
			if (this.heap.length > 0 && last !== undefined) this.heap[0] = last;
		}
		let index = 0;
		while (index < this.heap.length) {
			let child = index * 2 + 1;
			const left = this.heap[child];
			const parent = this.heap[index];
			if (left === undefined || parent === undefined) break;
			const right = this.heap[child + 1];
			if (right !== undefined && this.compare(right, left) < 0) child++;
			const next = this.heap[child];
			if (next === undefined || this.compare(parent, next) <= 0) break;
			this.heap[index] = next;
			this.heap[child] = parent;
			index = child;
		}
		this.after = name;
		return name;
	}

	async close(): Promise<void> {
		const directory = this.directory;
		this.directory = null;
		if (directory !== null) await directory.close();
	}
}
