<script lang="ts">
	import { saveConfigFile, type ConfigFile } from "$lib/api";

	interface Props {
		configFiles: ConfigFile[];
		selectedFile: string;
		onselectfile: (name: string) => void;
	}

	let { configFiles, selectedFile, onselectfile }: Props = $props();

	let editorContent = $state("");
	let saving = $state(false);
	let saved = $state(false);

	$effect(() => {
		if (!selectedFile && configFiles?.length) {
			onselectfile(configFiles[0].name);
		}
	});

	$effect(() => {
		const file = configFiles?.find((f) => f.name === selectedFile);
		editorContent = file?.content ?? "";
		saved = false;
	});

	function ext(name: string): string {
		return name.split(".").pop() ?? "";
	}

	async function saveFile() {
		saving = true;
		saved = false;
		try {
			const success = await saveConfigFile(selectedFile, editorContent);
			if (success) {
				saved = true;
				setTimeout(() => (saved = false), 2000);
			}
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === "s") {
			e.preventDefault();
			saveFile();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="editor-chrome">
	<div class="editor-breadcrumb">
		<span class="editor-path">~/.agents/</span><span class="editor-filename">{selectedFile}</span>
	</div>
	<div class="editor-actions">
		{#if saved}<span class="editor-saved">SAVED</span>{/if}
		<button class="btn-editor-save" onclick={saveFile} disabled={saving}>
			{saving ? 'SAVING…' : 'SAVE'}
		</button>
	</div>
</div>
<textarea
	class="editor"
	bind:value={editorContent}
	spellcheck="false"
	placeholder="Empty file..."
></textarea>
