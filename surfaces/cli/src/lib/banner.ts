import chalk from "chalk";

const BRAND_ORANGE = "#FF4D00";

/**
 * Dot-grid "S" mark, derived from web/marketing/public/Signet-Logo-White.png
 * via connected-component extraction (26 full circles plus 2 half-filled
 * eclipse dots on a 9x7 grid). Side-text alignment assumes narrow glyph
 * rendering (width 1 per mark cell); CJK-wide locales may misalign.
 */
const MARK_GRID = `
..●●●●...
.◐..●●●●.
●●●..●●..
..●●.....
......●●●
.●●●●..◑.
..●●●●...
`;
const MARK_ROWS = MARK_GRID.trim().split("\n");

function renderMark(): string[] {
	const orange = chalk.hex(BRAND_ORANGE);
	return MARK_ROWS.map((row) => [...row].map((cell) => (cell === "." ? "  " : orange(`${cell} `))).join(""));
}

/**
 * Full CLI banner for the bare `signet` invocation: ASCII brand mark on the
 * left, name / tagline / version vertically centered on the right.
 * Callers should gate on process.stdout.isTTY so piped/agent consumers get
 * plain help output without decorative art.
 */
export function signetBanner(options: { readonly version: string }): string {
	const mark = renderMark();
	const side: Record<number, string> = {
		2: chalk.bold("Signet CLI"),
		3: chalk.dim("Own your agent. Bring it anywhere."),
		4: chalk.dim(`v${options.version}`),
	};
	const lines = mark.map((row, i) => (side[i] ? `${row}  ${side[i]}` : row.trimEnd()));
	return `\n${lines.map((line) => `  ${line}`).join("\n")}\n`;
}
