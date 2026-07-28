<script lang="ts">
import type { ComponentProps } from "svelte";
import { Loader2Icon } from "$lib/icons";
import { cn } from "$lib/utils.js";

let { class: className, ...restProps }: ComponentProps<typeof Loader2Icon> = $props();
</script>

<Loader2Icon
	role="status"
	aria-label="Loading"
	class={cn("size-4 animate-spin", className)}
	{...restProps}
/>
