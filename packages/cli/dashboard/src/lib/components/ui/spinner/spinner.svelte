<script lang="ts">
import { cn } from "$lib/utils.js";
import type Loader2Icon from "@lucide/svelte/icons/loader-2";
import type { ComponentProps } from "svelte";

const { class: className, ...restProps }: ComponentProps<typeof Loader2Icon> = $props();
</script>

<Loader2Icon
	role="status"
	aria-label="Loading"
	class={cn("size-4 animate-spin", className)}
	{...restProps}
/>
