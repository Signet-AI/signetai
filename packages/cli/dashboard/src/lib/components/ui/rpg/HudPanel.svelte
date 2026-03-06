<!-- HudPanel.svelte — wraps any content with HUD corner brackets -->
<script lang="ts">
  interface Props {
    class?: string;
    color?: string;
    size?: number;
    weight?: number;
    children?: any;
  }
  let {
    class: extraClass = '',
    color = 'var(--rpg-gold)',
    size = 10,
    weight = 1.5,
    children,
  }: Props = $props();
</script>

<div
  class="hud-panel-wrap {extraClass}"
  style="
    --hud-color: {color};
    --hud-size: {size}px;
    --hud-weight: {weight}px;
  "
>
  {@render children?.()}
</div>

<style>
  .hud-panel-wrap {
    position: relative;
  }
  .hud-panel-wrap::before,
  .hud-panel-wrap::after {
    content: '';
    position: absolute;
    width: var(--hud-size);
    height: var(--hud-size);
    pointer-events: none;
    z-index: 10;
  }
  .hud-panel-wrap::before {
    top: 0; left: 0;
    border-top: var(--hud-weight) solid var(--hud-color);
    border-left: var(--hud-weight) solid var(--hud-color);
  }
  .hud-panel-wrap::after {
    bottom: 0; right: 0;
    border-bottom: var(--hud-weight) solid var(--hud-color);
    border-right: var(--hud-weight) solid var(--hud-color);
  }
</style>
