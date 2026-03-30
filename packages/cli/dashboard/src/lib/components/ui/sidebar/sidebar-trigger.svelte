<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import { cn } from "$lib/utils.js";
import PanelLeftIcon from "@lucide/svelte/icons/panel-left";
import type { ComponentProps } from "svelte";
import type { Snippet } from "svelte";
import { useSidebar } from "./context.svelte.js";

let {
	ref = $bindable(null),
	class: className,
	onclick,
	children,
	mobileOnly = false,
	unstyled = false,
	...restProps
}: ComponentProps<typeof Button> & {
	onclick?: (e: MouseEvent) => void;
	children?: Snippet;
	mobileOnly?: boolean;
	unstyled?: boolean;
} = $props();

const sidebar = useSidebar();

function handleClick(e: MouseEvent) {
	onclick?.(e);
	sidebar.toggle();
}
</script>

{#if !(sidebar.isMobile && sidebar.openMobile) && (sidebar.isMobile || !mobileOnly)}
{#if unstyled}
<button
	data-sidebar="trigger"
	data-slot="sidebar-trigger"
	class={cn(className)}
	type="button"
	onclick={handleClick}
	bind:this={ref}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<PanelLeftIcon />
	{/if}
	<span class="sr-only">Toggle Sidebar</span>
</button>
{:else}
<Button
	data-sidebar="trigger"
	data-slot="sidebar-trigger"
	variant="ghost"
	size="icon"
	class={cn("size-7", className)}
	type="button"
	onclick={handleClick}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<PanelLeftIcon />
	{/if}
	<span class="sr-only">Toggle Sidebar</span>
</Button>
{/if}
{/if}
