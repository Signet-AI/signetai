<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { st } from "$lib/stores/settings.svelte";

const selectTriggerClass =
	"font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-none w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-none";
const selectItemClass = "font-[family-name:var(--font-mono)] text-[11px] rounded-none";

function handleProviderChange(v: string | undefined) {
	st.sSetStr([...st.embPath(), "provider"], v ?? "");
}
</script>

{#if st.settingsFileName}
	<FormSection title="Embeddings" defaultOpen={false} description="Vector embedding configuration for semantic memory search. Embeddings power the vector half of hybrid recall.">
		<FormField label="Provider" description="Embedding backend. Ollama runs locally, OpenAI requires an API key.">
			<Select.Root
				type="single"
				value={st.sStr([...st.embPath(), "provider"])}
				onValueChange={handleProviderChange}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.sStr([...st.embPath(), "provider"]) || "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="— select —" />
					<Select.Item class={selectItemClass} value="ollama" label="ollama" />
					<Select.Item class={selectItemClass} value="openai" label="openai" />
				</Select.Content>
			</Select.Root>
		</FormField>
		<FormField label="Model" description="Ollama: nomic-embed-text (768d), all-minilm (384d), mxbai-embed-large (1024d). OpenAI: text-embedding-3-small (1536d), text-embedding-3-large (3072d).">
			<Input value={st.sStr([...st.embPath(), "model"])} oninput={(e) => st.sSetStr([...st.embPath(), "model"], e.currentTarget.value)} />
		</FormField>
		<FormField label="Dimensions" description="Must match the model's output dimension. Mismatched dimensions will produce broken search results.">
			<Input type="number" value={st.sNum([...st.embPath(), "dimensions"])} oninput={(e) => st.sSetNum([...st.embPath(), "dimensions"], e.currentTarget.value)} />
		</FormField>
		<FormField label="Base URL" description="Ollama default: http://localhost:11434. OpenAI default: https://api.openai.com/v1.">
			<Input value={st.sStr([...st.embPath(), "base_url"])} oninput={(e) => st.sSetStr([...st.embPath(), "base_url"], e.currentTarget.value)} />
		</FormField>
		<FormField label="API Key" description="Optional for Ollama, required for OpenAI. Use $secret:NAME to reference a stored secret instead of plaintext.">
			<Input type="password" value={st.sStr([...st.embPath(), "api_key"])} oninput={(e) => st.sSetStr([...st.embPath(), "api_key"], e.currentTarget.value)} />
		</FormField>
	</FormSection>
{/if}
