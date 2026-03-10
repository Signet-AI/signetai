<script lang="ts">
import type { Dialog as SheetPrimitive } from "bits-ui";

const { open = $bindable(false), ...restProps }: SheetPrimitive.RootProps = $props();
</script>

<SheetPrimitive.Root bind:open {...restProps} />
