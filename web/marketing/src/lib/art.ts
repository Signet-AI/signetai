import { renderArt } from "./cover-field";
export interface ArtPiece {
	readonly width: number;
	readonly height: number;
	readonly render: () => Promise<Buffer>;
}

export const ART = {
	masthead: { width: 2000, height: 750, render: () => renderArt("signet-blog", "horizon", "night", 2000, 750) },
	floor: {
		width: 2400,
		height: 800,
		render: () => renderArt("signet-start", "floor", "electric", 2400, 800, true, 120),
	},
	sources: {
		width: 2200,
		height: 900,
		render: () => renderArt("signet-sources", "stream", "electric", 2200, 900, true, 150),
	},
} as const satisfies Record<string, ArtPiece>;

export type ArtName = keyof typeof ART;

export function artUrl(name: ArtName): string {
	return `/art/${name}.webp`;
}
