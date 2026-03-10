<script lang="ts">
import { cn } from "$lib/utils.js";
import type { Tabs as TabsPrimitive } from "bits-ui";

const {
	ref = $bindable(null),
	value = $bindable(""),
	class: className,
	...restProps
}: TabsPrimitive.RootProps = $props();
</script>

<TabsPrimitive.Root
	bind:ref
	bind:value
	data-slot="tabs"
	class={cn("flex flex-col gap-2", className)}
	{...restProps}
/>
