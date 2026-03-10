<script lang="ts">
import type { Tooltip as TooltipPrimitive } from "bits-ui";

const { ...restProps }: TooltipPrimitive.PortalProps = $props();
</script>

<TooltipPrimitive.Portal {...restProps} />
