<script lang="ts">
import { cn } from "$lib/utils.js";
import type { Dialog as SheetPrimitive } from "bits-ui";

const { ref = $bindable(null), class: className, ...restProps }: SheetPrimitive.DescriptionProps = $props();
</script>

<SheetPrimitive.Description
	bind:ref
	data-slot="sheet-description"
	class={cn("text-muted-foreground text-sm", className)}
	{...restProps}
/>
