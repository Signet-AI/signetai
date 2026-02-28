<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import { st } from "$lib/stores/settings.svelte";

function setStr(path: string[]) {
	return (e: Event) => {
		st.sSetStr(path, (e.currentTarget as HTMLInputElement).value);
	};
}
</script>

{#if st.settingsFileName}
	<FormSection title="Paths" defaultOpen={false} description="File paths for memory storage. All paths are relative to ~/.agents/ (or $SIGNET_PATH).">
		<FormField label="Database" description="SQLite database file for structured memory storage.">
			<Input value={st.sStr(["paths", "database"])} oninput={setStr(["paths", "database"])} />
		</FormField>
		<FormField label="MEMORY.md" description="Output path for the auto-generated working memory summary.">
			<Input value={st.sStr(["paths", "current_md"])} oninput={setStr(["paths", "current_md"])} />
		</FormField>
	</FormSection>
{/if}