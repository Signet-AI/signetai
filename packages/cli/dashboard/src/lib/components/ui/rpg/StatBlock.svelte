<!-- StatBlock.svelte — RPG stat display (e.g. "247 Memories | 12 Skills Equipped") -->
<script lang="ts">
  interface Stat {
    label: string;
    value: string | number;
    color?: string;
    icon?: string;
  }
  interface Props {
    stats: Stat[];
    columns?: number;
  }
  let { stats, columns = 2 }: Props = $props();
</script>

<div
  class="stat-block"
  style="grid-template-columns: repeat({columns}, minmax(0,1fr))"
>
  {#each stats as stat (stat.label)}
    <div class="stat-item">
      <span class="stat-value" style={stat.color ? `color:${stat.color}` : ''}>
        {#if stat.icon}<span class="stat-icon" aria-hidden="true">{stat.icon}</span>{/if}
        {stat.value}
      </span>
      <span class="stat-label">{stat.label}</span>
    </div>
  {/each}
</div>

<style>
  .stat-block {
    display: grid;
    gap: 6px;
  }
  .stat-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--sig-border-strong);
    background: color-mix(in srgb, var(--sig-surface-raised) 55%, transparent);
    border-radius: 3px;
  }
  .stat-value {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    color: var(--sig-text-bright);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .stat-icon { font-style: normal; }
  .stat-label {
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--sig-text-muted);
  }
</style>
