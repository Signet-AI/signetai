export const DB_OWNER_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class DbOwnerFrameTooLargeError extends Error {
	readonly code = "DB_OWNER_FRAME_TOO_LARGE";

	constructor() {
		super("DB owner protocol frame exceeds its byte limit");
		this.name = "DbOwnerFrameTooLargeError";
	}
}

export class DbOwnerLineBuffer {
	private readonly fragments: string[] = [];
	private bytes = 0;

	constructor(private readonly maxBytes = DB_OWNER_MAX_FRAME_BYTES) {}

	read(chunk: string): readonly string[] {
		const lines: string[] = [];
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf("\n", start);
			const tail = chunk.slice(start, end === -1 ? chunk.length : end);
			this.bytes += Buffer.byteLength(tail);
			if (this.bytes > this.maxBytes) {
				this.reset();
				throw new DbOwnerFrameTooLargeError();
			}
			if (end === -1) {
				this.fragments.push(tail);
				break;
			}
			if (this.fragments.length === 0) lines.push(tail);
			else {
				this.fragments.push(tail);
				lines.push(this.fragments.join(""));
			}
			this.reset();
			start = end + 1;
		}
		return lines;
	}

	reset(): void {
		this.fragments.length = 0;
		this.bytes = 0;
	}
}
