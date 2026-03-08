<script lang="ts">
import AdvancedSection from "$lib/components/config/AdvancedSection.svelte";
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import { st } from "$lib/stores/settings.svelte";
</script>

{#if st.settingsFileName}
	<FormSection description="Memory system settings. Controls how much context is injected into sessions and how memories age over time.">
		<FormField label="Session budget" description="Character limit for context injected at session start via hooks. Default: 2000.">
			<Input type="number" value={st.sNum(["memory", "session_budget"])} oninput={(e) => st.sSetNum(["memory", "session_budget"], e.currentTarget.value)} />
		</FormField>
		<FormField label="MEMORY.md budget" description="Character limit for the auto-generated MEMORY.md summary. Default: 10000.">
			<Input type="number" value={st.sNum(["memory", "current_md_budget"])} oninput={(e) => st.sSetNum(["memory", "current_md_budget"], e.currentTarget.value)} />
		</FormField>
		<FormField label="Decay rate" description="Daily importance decay factor for non-pinned memories. Formula: importance(t) = base × decay_rate^days. 0.99 = slow, 0.95 = default, 0.90 = fast.">
			<Input type="number" min="0" max="1" step="0.01" value={st.sNum(["memory", "decay_rate"])} oninput={(e) => st.sSetNum(["memory", "decay_rate"], e.currentTarget.value)} />
		</FormField>

		<AdvancedSection>
			<p class="text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-warning,#d4a017)] mb-3">
				Changing paths can break your setup. Only modify if you know what you're doing.
			</p>
			<FormField label="Database path" description="SQLite database file for structured memory storage.">
				<Input value={st.sStr(["paths", "database"])} oninput={(e) => st.sSetStr(["paths", "database"], e.currentTarget.value)} />
			</FormField>
			<FormField label="MEMORY.md path" description="Output path for the auto-generated working memory summary.">
				<Input value={st.sStr(["paths", "current_md"])} oninput={(e) => st.sSetStr(["paths", "current_md"], e.currentTarget.value)} />
			</FormField>
		</AdvancedSection>
	</FormSection>
{/if}
