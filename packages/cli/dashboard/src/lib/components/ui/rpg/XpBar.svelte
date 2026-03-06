<!-- XpBar.svelte -->
<script lang="ts">
  interface Props {
    value: number;
    label?: string;
    color?: string;
    height?: number;
    animated?: boolean;
  }
  let {
    value,
    label = '',
    color = 'var(--rpg-gold)',
    height = 3,
    animated = true,
  }: Props = $props();

  let clampedValue = $derived(Math.min(100, Math.max(0, value)));
</script>

<div class="xp-bar-wrap">
  {#if label}
    <div class="xp-bar-label">
      <span class="sig-eyebrow" style="color: {color}">{label}</span>
    </div>
  {/if}
  <div
    class="xp-bar-track"
    style="height: {height}px; background: color-mix(in srgb, {color} 15%, transparent);"
    role="progressbar"
    aria-valuenow={clampedValue}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      class="xp-bar-fill {animated ? 'xp-bar-animated' : ''}"
      style="width: {clampedValue}%; background: {color};"
    ></div>
  </div>
</div>

<style>
  .xp-bar-wrap { width: 100%; }
  .xp-bar-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .xp-bar-track {
    width: 100%;
    border-radius: 9999px;
    overflow: hidden;
  }
  .xp-bar-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .xp-bar-animated {
    animation: xp-fill 1s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes xp-fill {
    from { width: 0%; }
  }
</style>
