<script lang="ts">
import { cn } from "$lib/utils.js";
import type { Dialog as SheetPrimitive } from "bits-ui";

const { ref = $bindable(null), class: className, ...restProps }: SheetPrimitive.TitleProps = $props();
</script>

<SheetPrimitive.Title
	bind:ref
	data-slot="sheet-title"
	class={cn("text-foreground font-semibold", className)}
	{...restProps}
/>
