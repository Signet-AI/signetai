<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { st } from "$lib/stores/settings.svelte";

function formatDate(raw: unknown): string {
	if (!raw) return "";
	try {
		return new Date(String(raw)).toLocaleString();
	} catch {
		return String(raw);
	}
}

function setStr(path: string[]) {
	return (e: Event) => {
		st.aSetStr(path, (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
	};
}
</script>

{#if st.agentFile}
	<FormSection description="Core identity metadata. Created by signet setup, synced to all harnesses on change.">
		<FormField label="Name" description="Display name shown in harness configs and session context.">
			<Input value={st.aStr(["agent", "name"])} oninput={setStr(["agent", "name"])} />
		</FormField>
		<FormField label="Description" description="Short description of the agent's role and purpose.">
			<Textarea rows={3} value={st.aStr(["agent", "description"])} oninput={setStr(["agent", "description"])} />
		</FormField>
		<FormField label="Created" description="ISO 8601 creation timestamp. Read-only.">
			<Input class="text-[var(--sig-text-muted)] cursor-default" readonly value={formatDate(st.get(st.agent, "agent", "created"))} />
		</FormField>
		<FormField label="Updated" description="ISO 8601 last update timestamp. Read-only.">
			<Input class="text-[var(--sig-text-muted)] cursor-default" readonly value={formatDate(st.get(st.agent, "agent", "updated"))} />
		</FormField>
	</FormSection>
{/if}
