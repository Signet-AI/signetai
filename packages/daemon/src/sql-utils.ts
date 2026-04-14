export function escapeLike(text: string): string {
	return text.replace(/([\\%_])/g, "\\$1");
}
