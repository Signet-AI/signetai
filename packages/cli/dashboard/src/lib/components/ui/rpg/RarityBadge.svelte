<!-- RarityBadge.svelte -->
<script lang="ts">
  type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  interface Props {
    rarity: Rarity;
    size?: 'sm' | 'md';
  }
  let { rarity, size = 'sm' }: Props = $props();

  const LABELS: Record<Rarity, string> = {
    common:    'Common',
    uncommon:  'Uncommon',
    rare:      'Rare',
    epic:      'Epic',
    legendary: 'Legendary',
  };

  const COLORS: Record<Rarity, string> = {
    common:    'var(--rarity-common)',
    uncommon:  'var(--rarity-uncommon)',
    rare:      'var(--rarity-rare)',
    epic:      'var(--rarity-epic)',
    legendary: 'var(--rarity-legendary)',
  };

  const GLOWS: Record<Rarity, string> = {
    common:    'none',
    uncommon:  'var(--rarity-uncommon-glow)',
    rare:      'var(--rarity-rare-glow)',
    epic:      'var(--rarity-epic-glow)',
    legendary: 'var(--rarity-legendary-glow)',
  };

  let color = $derived(COLORS[rarity]);
  let glow  = $derived(GLOWS[rarity]);
  let label = $derived(LABELS[rarity]);
</script>

<span
  class="rarity-badge rarity-badge--{size}"
  style="color: {color}; border-color: {color}; box-shadow: {glow};"
  aria-label="Rarity: {label}"
>
  {label}
</span>

<style>
  .rarity-badge {
    display: inline-block;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border: 1px solid currentColor;
    border-radius: 2px;
    white-space: nowrap;
  }
  .rarity-badge--sm {
    font-size: 8px;
    padding: 1px 4px;
  }
  .rarity-badge--md {
    font-size: 10px;
    padding: 2px 6px;
  }
</style>
