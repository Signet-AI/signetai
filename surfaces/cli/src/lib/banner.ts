import chalk from "chalk";

const BRAND_ORANGE = "#FF4D00";
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
