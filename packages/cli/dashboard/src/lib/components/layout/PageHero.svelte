<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	title: string;
	wordmarkLines: ReadonlyArray<string>;
	wordmarkMaxWidth?: string;
	eyebrow: string;
	description: string;
	meta?: Snippet;
	actions?: Snippet;
}

let {
	title,
	wordmarkLines,
	wordmarkMaxWidth = "260px",
	eyebrow,
	description,
	meta,
	actions,
}: Props = $props();

const BLOCK_FONT: Record<
	string,
	readonly [string, string, string, string, string]
> = {
	A: [" █ ", "█ █", "███", "█ █", "█ █"],
	B: ["██ ", "█ █", "██ ", "█ █", "██ "],
	C: [" ██", "█  ", "█  ", "█  ", " ██"],
	D: ["██ ", "█ █", "█ █", "█ █", "██ "],
	E: ["███", "█  ", "██ ", "█  ", "███"],
	F: ["███", "█  ", "██ ", "█  ", "█  "],
	G: [" ██", "█  ", "█ █", "█ █", " ██"],
	H: ["█ █", "█ █", "███", "█ █", "█ █"],
	I: ["███", " █ ", " █ ", " █ ", "███"],
	J: ["███", "  █", "  █", "█ █", " █ "],
	K: ["█ █", "█ █", "██ ", "█ █", "█ █"],
	L: ["█  ", "█  ", "█  ", "█  ", "███"],
	M: ["█ █", "███", "███", "█ █", "█ █"],
	N: ["█ █", "███", "███", "███", "█ █"],
	O: [" █ ", "█ █", "█ █", "█ █", " █ "],
	P: ["██ ", "█ █", "██ ", "█  ", "█  "],
	Q: [" █ ", "█ █", "█ █", "███", "  █"],
	R: ["██ ", "█ █", "██ ", "█ █", "█ █"],
	S: [" ██", "█  ", " █ ", "  █", "██ "],
	T: ["███", " █ ", " █ ", " █ ", " █ "],
	U: ["█ █", "█ █", "█ █", "█ █", "███"],
	V: ["█ █", "█ █", "█ █", "█ █", " █ "],
	W: ["█ █", "█ █", "███", "███", "█ █"],
	X: ["█ █", "█ █", " █ ", "█ █", "█ █"],
	Y: ["█ █", "█ █", " █ ", " █ ", " █ "],
	Z: ["███", "  █", " █ ", "█  ", "███"],
	"-": ["   ", "   ", "███", "   ", "   "],
	" ": ["   ", "   ", "   ", "   ", "   "],
	"?": ["██ ", "  █", " █ ", "   ", " █ "],
};

function renderAsciiLine(input: string): string {
	const rows = ["", "", "", "", ""];
	for (const char of input) {
		const glyph = BLOCK_FONT[char] ?? BLOCK_FONT["?"];
		for (let i = 0; i < rows.length; i += 1) {
			rows[i] += `${glyph[i]} `;
		}
	}
	return rows.map((row) => row.trimEnd()).join("\n");
}

function renderWordmark(lines: ReadonlyArray<string>): string {
	return lines
		.map((line) => renderAsciiLine(line.toUpperCase()))
		.join("\n\n");
}

let asciiWordmark = $derived(renderWordmark(wordmarkLines));
</script>

<div
	class="shrink-0 px-[var(--space-md)] pt-[var(--space-md)]
		pb-[var(--space-sm)] border-b border-[var(--sig-border)]"
>
	<div class="flex items-start gap-6 min-h-[112px]">
		<div class="flex flex-col gap-1 shrink-0">
			<h1 class="absolute hidden">{title}</h1>
			<div
				class="relative overflow-hidden"
				style={`max-width: ${wordmarkMaxWidth};`}
			>
				<pre
					class="hero-ascii m-0 text-[var(--sig-text-muted)]
						select-none whitespace-pre"
					aria-hidden="true"
				>{asciiWordmark}</pre>
				<pre
					class="hero-ascii absolute left-px top-px m-0
						text-[var(--sig-text-bright)] select-none whitespace-pre"
					aria-label={title}
				>{asciiWordmark}</pre>
			</div>
			<span
				class="font-[family-name:var(--font-mono)] text-[10px]
					font-medium text-[var(--sig-text)] uppercase
					tracking-[0.12em]"
			>
				{eyebrow}
			</span>
			{#if meta}
				{@render meta()}
			{/if}
		</div>

		<div class="flex-1 flex flex-col gap-2 pt-[2px] min-w-0">
			<p
				class="text-[12px] text-[var(--sig-text)] leading-[1.5] m-0
					max-w-[460px]"
			>
				{description}
			</p>
			{#if actions}
				<div class="flex gap-2 flex-wrap">
					{@render actions()}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.hero-ascii {
		font-size: 8px;
		line-height: 1.15;
		font-family: var(--font-mono);
		letter-spacing: -0.04em;
	}
</style>
