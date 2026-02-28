<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { st } from "$lib/stores/settings.svelte";

function setNum(path: string[]) {
	return (e: Event) => {
		st.sSetNum(path, (e.currentTarget as HTMLInputElement).value);
	};
}

function setBool(path: string[]) {
	return (v: boolean | string) => {
		st.sSetBool(path, !!v);
	};
}
</script>

{#if st.settingsFileName}
	<FormSection title="Search" defaultOpen={false} description="Hybrid search tuning. Controls the blend between semantic (vector) and keyword (BM25) retrieval.">
		<FormField label="Alpha" description="Vector weight (0–1). At 0.9 results are heavily semantic; at 0.3 they skew toward keyword matching. Default 0.7 works well generally.">
			<Input type="number" min="0" max="1" step="0.1" value={st.sNum(["search", "alpha"])} oninput={setNum(["search", "alpha"])} />
		</FormField>
		<FormField label="Top K" description="Candidate count fetched from each source (BM25 and vector) before alpha-blending. Default: 20.">
			<Input type="number" value={st.sNum(["search", "top_k"])} oninput={setNum(["search", "top_k"])} />
		</FormField>
		<FormField label="Min Score" description="Minimum combined score to include in results. Results below this threshold are dropped. Default: 0.3.">
			<Input type="number" min="0" max="1" step="0.1" value={st.sNum(["search", "min_score"])} oninput={setNum(["search", "min_score"])} />
		</FormField>
		
		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Rehearsal Boost
		</div>
		
		<FormField label="Rehearsal enabled" description="Boost scores for frequently-recalled memories. Uses access_count and last_accessed to reward useful memories.">
			<Switch checked={st.sBool(["search", "rehearsal_enabled"])} onCheckedChange={setBool(["search", "rehearsal_enabled"])} />
		</FormField>
		<FormField label="Rehearsal weight" description="Score multiplier for rehearsal boost. Higher = more impact from recall frequency. Default: 0.1.">
			<Input type="number" min="0" max="1" step="0.05" value={st.sNum(["search", "rehearsal_weight"])} oninput={setNum(["search", "rehearsal_weight"])} />
		</FormField>
		<FormField label="Rehearsal half-life (days)" description="Days until rehearsal boost decays to half. Lower = faster decay of recall-frequency boost. Default: 30.">
			<Input type="number" min="1" max="365" step="1" value={st.sNum(["search", "rehearsal_half_life_days"])} oninput={setNum(["search", "rehearsal_half_life_days"])} />
		</FormField>
	</FormSection>
{/if}