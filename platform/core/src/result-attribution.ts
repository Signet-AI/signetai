export interface AttributionName {
	readonly name: string;
	readonly handle?: string;
}
export interface ResultAttribution {
	readonly author?: AttributionName;
	readonly agent?: AttributionName;
}
function label(value: AttributionName): string {
	const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
	const name = clean(value.name),
		handle = value.handle ? clean(value.handle) : "";
	return handle && handle !== name ? `${name} (@${handle})` : name;
}
export function renderResultAttribution(value: ResultAttribution | undefined): string {
	if (!value) return "";
	return [value.author ? `author: ${label(value.author)}` : "", value.agent ? `agent: ${label(value.agent)}` : ""]
		.filter(Boolean)
		.join(" · ");
}
