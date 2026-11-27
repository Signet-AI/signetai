export class DbOwnerLineBuffer {
	private readonly fragments: string[] = [];

	read(chunk: string): readonly string[] {
		const lines: string[] = [];
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf("\n", start);
			if (end === -1) {
				this.fragments.push(chunk.slice(start));
				break;
			}
			const tail = chunk.slice(start, end);
			if (this.fragments.length === 0) lines.push(tail);
			else {
				this.fragments.push(tail);
				lines.push(this.fragments.join(""));
				this.reset();
			}
			start = end + 1;
		}
		return lines;
	}

	reset(): void {
		this.fragments.length = 0;
	}
}
