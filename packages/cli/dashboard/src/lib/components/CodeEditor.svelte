<script lang="ts">
import { onMount } from "svelte";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

interface Props {
	value: string;
	language: "yaml" | "markdown" | "text";
	readonly?: boolean;
	onchange?: (value: string) => void;
	onsave?: () => void;
}

let { value, language, readonly = false, onchange, onsave }: Props = $props();

let container: HTMLDivElement | undefined = $state();
let view: EditorView | undefined = $state();
const langCompartment = new Compartment();

function signetTheme(): Extension {
	return EditorView.theme({
		"&": {
			backgroundColor: "var(--sig-bg)",
			color: "var(--sig-text-bright)",
			fontFamily: "var(--font-mono)",
			fontSize: "13px",
			height: "100%",
		},
		".cm-content": {
			caretColor: "var(--sig-text-bright)",
			fontFamily: "var(--font-mono)",
			lineHeight: "1.8",
			padding: "var(--space-md) 0",
		},
		".cm-cursor, .cm-dropCursor": {
			borderLeftColor: "var(--sig-text-bright)",
		},
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
			backgroundColor: "rgba(255, 255, 255, 0.08) !important",
		},
		".cm-activeLine": {
			backgroundColor: "rgba(255, 255, 255, 0.03)",
		},
		".cm-gutters": {
			backgroundColor: "var(--sig-surface)",
			color: "var(--sig-text-muted)",
			border: "none",
			borderRight: "1px solid var(--sig-border)",
			fontFamily: "var(--font-mono)",
			fontSize: "11px",
		},
		".cm-activeLineGutter": {
			backgroundColor: "rgba(255, 255, 255, 0.04)",
			color: "var(--sig-text)",
		},
		".cm-foldGutter": {
			color: "var(--sig-text-muted)",
		},
		"&.cm-focused": {
			outline: "none",
		},
		".cm-matchingBracket": {
			backgroundColor: "rgba(255, 255, 255, 0.1)",
			color: "var(--sig-text-bright)",
		},
		".cm-searchMatch": {
			backgroundColor: "rgba(255, 255, 255, 0.12)",
		},
		".cm-selectionMatch": {
			backgroundColor: "rgba(255, 255, 255, 0.06)",
		},
		".cm-line": {
			padding: "0 var(--space-md)",
		},
		".cm-scroller": {
			overflow: "auto",
		},
	}, { dark: true });
}

function langExtension(): Extension {
	if (language === "yaml") return yaml();
	if (language === "markdown") return markdown();
	return [];
}

function buildExtensions(): Extension[] {
	const saveKeymap = keymap.of([{
		key: "Mod-s",
		run: () => { onsave?.(); return true; },
	}]);

	return [
		lineNumbers(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		history(),
		foldGutter(),
		bracketMatching(),
		closeBrackets(),
		highlightSelectionMatches(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		keymap.of([
			...defaultKeymap,
			...historyKeymap,
			...foldKeymap,
			...searchKeymap,
			...closeBracketsKeymap,
		]),
		signetTheme(),
		langCompartment.of(langExtension()),
		saveKeymap,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				onchange?.(update.state.doc.toString());
			}
		}),
		...(readonly ? [EditorState.readOnly.of(true)] : []),
	];
}

onMount(() => {
	if (!container) return;

	view = new EditorView({
		state: EditorState.create({
			doc: value,
			extensions: buildExtensions(),
		}),
		parent: container,
	});

	return () => {
		view?.destroy();
		view = undefined;
	};
});

// Sync external value changes into the editor
$effect(() => {
	if (!view) return;
	const current = view.state.doc.toString();
	if (value !== current) {
		view.dispatch({
			changes: { from: 0, to: current.length, insert: value },
		});
	}
});

// Reconfigure language when it changes
$effect(() => {
	const lang = language;
	if (view) {
		view.dispatch({
			effects: langCompartment.reconfigure(
				lang === "yaml" ? yaml() : lang === "markdown" ? markdown() : [],
			),
		});
	}
});
</script>

<div class="code-editor" bind:this={container}></div>

<style>
	.code-editor {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	/* Light theme overrides via parent attribute */
	:global([data-theme="light"]) .code-editor :global(.cm-editor) {
		background-color: var(--sig-bg);
		color: var(--sig-text-bright);
	}

	:global([data-theme="light"]) .code-editor :global(.cm-gutters) {
		background-color: var(--sig-surface);
		color: var(--sig-text-muted);
		border-right-color: var(--sig-border);
	}

	:global([data-theme="light"]) .code-editor :global(.cm-activeLine) {
		background-color: rgba(0, 0, 0, 0.03);
	}

	:global([data-theme="light"]) .code-editor :global(.cm-activeLineGutter) {
		background-color: rgba(0, 0, 0, 0.04);
	}

	:global([data-theme="light"]) .code-editor :global(.cm-selectionBackground) {
		background-color: rgba(0, 0, 0, 0.08) !important;
	}

	:global([data-theme="light"]) .code-editor :global(.cm-cursor) {
		border-left-color: var(--sig-text-bright);
	}
</style>
