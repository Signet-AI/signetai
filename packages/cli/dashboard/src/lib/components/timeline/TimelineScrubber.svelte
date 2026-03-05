<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";

interface Props {
	start: string;
	end: string;
	onrangechange: (start: string, end: string) => void;
}

let { start, end, onrangechange }: Props = $props();

let tempStart = $state(start);
let tempEnd = $state(end);

$effect(() => {
	tempStart = start;
	tempEnd = end;
});

function applyRange(): void {
	if (tempStart && tempEnd && tempStart <= tempEnd) {
		onrangechange(tempStart, tempEnd);
	}
}

function setPreset(days: number): void {
	const endDate = new Date();
	const startDate = new Date();
	startDate.setDate(startDate.getDate() - days);

	tempEnd = endDate.toISOString().split("T")[0];
	tempStart = startDate.toISOString().split("T")[0];
	applyRange();
}

function setAllTime(): void {
	tempStart = "2000-01-01";
	tempEnd = new Date().toISOString().split("T")[0];
	applyRange();
}
</script>

<div class="flex items-center gap-3 flex-wrap">
	<div class="flex items-center gap-2">
		<label for="timeline-start" class="text-[10px] uppercase tracking-[0.06em] text-[var(--sig-text-muted)]">From</label>
		<Input
			id="timeline-start"
			type="date"
			bind:value={tempStart}
			class="h-7 w-32 text-xs font-[family-name:var(--font-mono)]"
		/>
	</div>

	<div class="flex items-center gap-2">
		<label for="timeline-end" class="text-[10px] uppercase tracking-[0.06em] text-[var(--sig-text-muted)]">To</label>
		<Input
			id="timeline-end"
			type="date"
			bind:value={tempEnd}
			class="h-7 w-32 text-xs font-[family-name:var(--font-mono)]"
		/>
	</div>

	<Button
		variant="outline"
		size="sm"
		class="h-7 text-[11px]"
		onclick={applyRange}
	>
		Apply
	</Button>

	<div class="flex items-center gap-1 ml-2">
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-[10px] px-2"
			onclick={() => setPreset(7)}
		>
			7d
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-[10px] px-2"
			onclick={() => setPreset(30)}
		>
			30d
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-[10px] px-2"
			onclick={() => setPreset(90)}
		>
			90d
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-[10px] px-2"
			onclick={setAllTime}
		>
			All
		</Button>
	</div>
</div>
