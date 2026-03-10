<script lang="ts">
import type { Dialog as SheetPrimitive } from "bits-ui";

const { ...restProps }: SheetPrimitive.PortalProps = $props();
</script>

<SheetPrimitive.Portal {...restProps} />
