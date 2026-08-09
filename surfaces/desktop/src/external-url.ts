export function validateExternalUrl(url: unknown): string {
	if (typeof url !== "string") throw new Error("A URL is required");
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs can be opened externally");
	return url;
}
