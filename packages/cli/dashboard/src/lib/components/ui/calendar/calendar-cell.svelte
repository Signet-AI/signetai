<script lang="ts">
import { cn } from "$lib/utils.js";
import type { Calendar as CalendarPrimitive } from "bits-ui";

const { ref = $bindable(null), class: className, ...restProps }: CalendarPrimitive.CellProps = $props();
</script>

<CalendarPrimitive.Cell
	bind:ref
	class={cn(
		"relative size-(--cell-size) p-0 text-center text-sm focus-within:z-20 [&:first-child[data-selected]_[data-bits-day]]:rounded-s-md [&:last-child[data-selected]_[data-bits-day]]:rounded-e-md",
		className
	)}
	{...restProps}
/>
