# UXGameV3 — Implementation Plan

**Branch:** `UXGameV3`  
**Design vision:** v2's clean dark modern dashboard as the base, with v1's warm RPG soul layered on top.  
The goldilocks zone: Destiny 2 character menu meets Vercel dashboard.  
Clean enough for non-gamers. Gamified enough that players go "wait... is this an inventory system?"

---

## Design System

### Color Tokens (new additions to `app.css`)

```css
/* RPG accent palette — to be added to :root */
--rpg-gold: #f59e0b;
--rpg-gold-glow: rgba(245, 158, 11, 0.15);
--rpg-teal: #14b8a6;
--rpg-teal-glow: rgba(20, 184, 166, 0.15);
--rpg-purple: #a855f7;
--rpg-purple-glow: rgba(168, 85, 247, 0.15);

/* Rarity tier system */
--rarity-common: #6b7280;
--rarity-uncommon: #22c55e;
--rarity-rare: #3b82f6;
--rarity-epic: #a855f7;
--rarity-legendary: #f59e0b;

/* Rarity glow borders */
--rarity-common-glow: rgba(107, 114, 128, 0.3);
--rarity-uncommon-glow: rgba(34, 197, 94, 0.3);
--rarity-rare-glow: rgba(59, 130, 246, 0.3);
--rarity-epic-glow: rgba(168, 85, 247, 0.3);
--rarity-legendary-glow: rgba(245, 158, 11, 0.35);

/* HUD elements */
--hud-bracket-color: rgba(255, 255, 255, 0.12);
--hud-bracket-accent: var(--rpg-gold);
```

### Typography  
- Display: `Diamond Grotesk` (already present) — section headers keep this font  
- Mono: `Geist Mono` (already present) — stats, XP numbers, memory counts  
- Body: keep existing `--font-sans`  
- Add subtle letter-spacing to RPG header labels: `letter-spacing: 0.05em; text-transform: uppercase; font-size: 0.7rem`

### Grain Texture  
Already partially implemented. Increase `--sig-grain-opacity` to `0.06` and ensure it applies globally.

---

## Navigation Vocabulary (Sidebar Rename)

| Current Label | v3 RPG Label | Icon suggestion |
|---|---|---|
| Config | **Character Sheet** | `user-cog` or `scroll` |
| Memory | **Adventure Log** | `book-open` |
| Secrets | **The Vault** | `shield` (already ShieldCheck) |
| Marketplace/Skills | **Skill Armory** | `sword` or `package` |
| Tasks | **Quest Board** | `list-checks` (already) → `clipboard-list` |
| Engine | **Engine** | keep (it's technical infra) |

**Implementation:** `app-sidebar.svelte` — update `navItems` labels.

### Avatar/Identity Header
- Replace the current logo/name header with a **hexagonal avatar frame** using CSS clip-path  
- Add XP bar below identity name (driven by `memCount` — "XP from memories")  
- Level derived from `memCount` milestones (100 mems = Lv2, 500 = Lv3, etc.)  
- Format: `LVL 4 · ARCHIVIST` — class title based on agent config  

---

## Screen-by-Screen Plan

### Screen 1-3: Onboarding Flow (NEW)
> **Agent Forge → Archetype → Starting Loadout**

Currently there is no onboarding flow — first-time users see a blank dashboard. This is a new feature.

**Files to create:**
- `src/lib/components/onboarding/AgentForge.svelte` — Name your agent
- `src/lib/components/onboarding/ArchetypeSelect.svelte` — Choose archetype (Developer / Analyst / Creator / Operator)
- `src/lib/components/onboarding/StartingLoadout.svelte` — Pick starting skills/connectors

**Trigger:** show if `identity.name` is default/empty AND no memories exist.  
**State:** `src/lib/stores/onboarding.svelte.ts`

**Design details:**
- Dark panel centered on screen, `max-w-lg`  
- Glowing border matching the selected archetype's accent color  
- Step indicator: `[ ◈ ] → [ ◈ ] → [ ◈ ]` at the top  
- Input has a subtle pulsing glow animation on focus  
- "FORGE YOUR IDENTITY" CTA button with gold glow  

---

### Screen 4: Main Hub (Dashboard) — `ConfigTab.svelte` / root layout

**Changes:**
- Add a **stat grid** at the top of the dashboard (3-4 columns):
  - Memories: `{memCount}` with `<Brain>` icon and teal glow
  - Active Skills: count with `<Sword>` icon and gold glow  
  - Connectors: count with `<Plug>` icon and purple glow  
  - XP / Level badge: computed from memCount  
- Section headers get HUD corner brackets (see HUD component below)  
- Subtle noise grain already present — keep at `0.06`  

---

### Screen 5: Character Sheet — `ConfigTab.svelte`

**Changes:**
- Page header: "CHARACTER SHEET" in uppercase tracking with a faint gold rule below  
- The identity fields (name, soul, instructions) render as "stat blocks":
  - Label in muted uppercase monospace  
  - Value in normal text with subtle left border accent  
- Harnesses section → "**EQUIPPED LOADOUT**" section header  
- Each harness shown as an "equipped item slot" card with icon, name, status badge  
- Status badge uses rarity colors: active = green, error = red, warning = gold  

---

### Screen 6-7: Skill Armory + Skill Detail — `SkillsTab.svelte`, `SkillCard.svelte`, `SkillDetail.svelte`

This is the most visual change.

**SkillCard.svelte:**
- Add `rarity` prop (common/uncommon/rare/epic/legendary) — computed from skill metadata or a fixed mapping from ClawdHub  
- Rarity glow border: `box-shadow: 0 0 12px var(--rarity-{tier}-glow); border-color: var(--rarity-{tier})`
- Rarity dot in top-right corner of card  
- Skill icon gets a soft background glow matching rarity color  
- Hover state: lift (`translateY(-2px)`) + intensify glow  

**SkillGrid.svelte:**
- Add filter bar: All / Common / Rare / Epic (filter by rarity)  
- Section header: "SKILL ARMORY" with HUD brackets  

**SkillDetail.svelte:**
- Right-panel or full page expanded view  
- Header: skill icon large, name, rarity badge  
- Stats section: version, author, install date  
- "EQUIP" / "UNEQUIP" button with gold glow CTA  
- Description in styled prose block  

---

### Screen 8: Server Map — `MarketplaceTab.svelte` / `McpServersTab.svelte`

**Changes:**
- Section header: "**SERVER MAP**" / "**NETWORK TOPOLOGY**"  
- Each MCP server card has a connection status indicator (pulse animation for active, dim for inactive = "fog of war" feeling)  
- Connected servers: bright teal glow dot  
- Disconnected: muted gray dot  
- Add subtle grid background pattern to the section (CSS radial dots)  
- Arrange in a visual grid vs pure list where possible  

---

### Screen 9-10: Adventure Log (Memory) — `MemoryTab.svelte`, `MemoryForm.svelte`

**Changes:**
- Section header: "**ADVENTURE LOG**"  
- Memory type badges (episodic/semantic/etc.) get category glow colors — reuse existing `--sig-log-category-*` tokens  
- Each memory row: left-side colored bar matching category type  
- Search bar: glass-morphism style (backdrop-blur + subtle border glow)  
- Memory detail view: full entry with metadata stats displayed as "log entry" style  
  - Top bar: timestamp, source harness, memory type badge  
  - Body: memory content in readable prose  
  - Footer: embedding vector visualization (already exists in EmbeddingsTab — link to it)  
- Add "pinned memories" as a "Featured Memories" section at top with gold bookmark icon  

---

### Screen 11: The Vault (Secrets) — `SecretsTab.svelte`

**Changes:**
- Section header: "**THE VAULT**"  
- Shield integrity indicator at the top: a horizontal bar showing `secrets locked / total` with a shield icon and gold glow  
- Each secret row: lock icon, name, masked value `••••••••`, reveal button  
- Add/Edit modal: dark panel with gold border glow  
- Category grouping: API Keys / Auth Tokens / Passwords / Other  
- Empty state: "**YOUR VAULT IS EMPTY** — No secrets stored yet"  

---

### Screen 12: Quest Board (Tasks) — `TaskBoard.svelte`, `TasksTab.svelte`

**Changes:**
- Section header: "**QUEST BOARD**"  
- Task status columns: `PENDING` / `ACTIVE` / `COMPLETE` — styled as kanban columns  
- Each task card:
  - Priority/difficulty stars (1-5) in gold  
  - Status pill: warning gold = pending, teal = active, muted = complete  
  - Task name in display font  
  - Metadata row: source, created, duration  
- Active tasks: pulsing left border in teal  
- Completed tasks: muted with strikethrough effect  

---

## Shared Components to Create/Modify

### `HudPanel.svelte` (NEW)
A wrapper component that adds HUD corner brackets to any panel:
```svelte
<!-- Usage: <HudPanel accent="gold"> ... </HudPanel> -->
```
CSS: 4 corner decorations using `::before`/`::after` pseudo elements with thin L-shaped brackets.  
`accent` prop controls bracket color: `gold | teal | purple | default`

### `RarityBadge.svelte` (NEW)
```svelte
<!-- <RarityBadge tier="epic" /> → renders colored dot + label -->
```

### `XpBar.svelte` (NEW)  
For the sidebar identity header and character sheet.  
```svelte
<!-- <XpBar current={memCount} next={nextMilestone} /> -->
```
Thin progress bar with gold fill and subtle glow.

### `StatBlock.svelte` (NEW)
For character sheet and dashboard stats grid.
```svelte
<!-- <StatBlock label="MEMORIES" value={memCount} icon={Brain} accent="teal" /> -->
```

### Updated: `app-sidebar.svelte`
- Rename nav items (see vocabulary table above)  
- Add hexagonal avatar + XP bar in sidebar header  
- Add level indicator `LVL {n} · {class}`  

---

## CSS Utilities (add to `app.css`)

```css
/* HUD corner brackets */
.hud-panel {
  position: relative;
}
.hud-panel::before, .hud-panel::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: var(--hud-bracket-color);
  border-style: solid;
  border-width: 0;
}
.hud-panel::before { top: -1px; left: -1px; border-top-width: 1px; border-left-width: 1px; }
.hud-panel::after  { top: -1px; right: -1px; border-top-width: 1px; border-right-width: 1px; }
/* Add bottom brackets via wrapper child */

/* Rarity glows */
.rarity-common    { border-color: var(--rarity-common);    box-shadow: 0 0 8px var(--rarity-common-glow); }
.rarity-uncommon  { border-color: var(--rarity-uncommon);  box-shadow: 0 0 8px var(--rarity-uncommon-glow); }
.rarity-rare      { border-color: var(--rarity-rare);      box-shadow: 0 0 10px var(--rarity-rare-glow); }
.rarity-epic      { border-color: var(--rarity-epic);      box-shadow: 0 0 14px var(--rarity-epic-glow); }
.rarity-legendary { border-color: var(--rarity-legendary); box-shadow: 0 0 20px var(--rarity-legendary-glow), 0 0 40px var(--rarity-legendary-glow); }

/* RPG section headers */
.rpg-section-label {
  font-family: var(--font-display);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sig-text-muted);
}

/* Aura icon glow */
.icon-aura-gold   { filter: drop-shadow(0 0 6px var(--rpg-gold)); }
.icon-aura-teal   { filter: drop-shadow(0 0 6px var(--rpg-teal)); }
.icon-aura-purple { filter: drop-shadow(0 0 6px var(--rpg-purple)); }

/* Pulse animation for active states */
@keyframes rpg-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.rpg-pulse { animation: rpg-pulse 2s ease-in-out infinite; }
```

---

## Implementation Order (Recommended)

### Phase 1 — Design Tokens + Sidebar (1-2 hours)
1. Add RPG color tokens to `app.css`  
2. Add CSS utilities (HUD brackets, rarity glows, aura effects, rpg-section-label)  
3. Rename sidebar nav labels  
4. Add hexagonal avatar frame + XP bar to sidebar header  

### Phase 2 — Skills Armory (2-3 hours)  
5. Update `SkillCard.svelte` with rarity prop + glow borders  
6. Add rarity filter to `SkillGrid.svelte`  
7. Update `SkillDetail.svelte` with epic item card layout  

### Phase 3 — Main Hub + Character Sheet (1-2 hours)  
8. Add stat grid to dashboard  
9. Update `ConfigTab.svelte` with character sheet header + stat blocks  

### Phase 4 — Adventure Log + Vault (2 hours)  
10. Update `MemoryTab.svelte` (section header, category glows, pinned memories)  
11. Update `SecretsTab.svelte` (vault header, shield bar, lock icons)  

### Phase 5 — Quest Board + Server Map (1-2 hours)  
12. Update `TaskBoard.svelte` with kanban columns + difficulty stars  
13. Update `McpServersTab.svelte` with topology grid + fog-of-war states  

### Phase 6 — Onboarding Flow (3-4 hours) 
14. Build `AgentForge.svelte`, `ArchetypeSelect.svelte`, `StartingLoadout.svelte`  
15. Add onboarding store + trigger logic  

---

## Files to Modify

```
packages/cli/dashboard/src/app.css                          ← design tokens + utilities
packages/cli/dashboard/src/lib/components/app-sidebar.svelte ← nav labels, avatar, XP bar
packages/cli/dashboard/src/lib/components/skills/SkillCard.svelte
packages/cli/dashboard/src/lib/components/skills/SkillGrid.svelte
packages/cli/dashboard/src/lib/components/skills/SkillDetail.svelte
packages/cli/dashboard/src/lib/components/tabs/ConfigTab.svelte
packages/cli/dashboard/src/lib/components/tabs/MemoryTab.svelte
packages/cli/dashboard/src/lib/components/tabs/SecretsTab.svelte
packages/cli/dashboard/src/lib/components/tabs/SkillsTab.svelte
packages/cli/dashboard/src/lib/components/tabs/TasksTab.svelte
packages/cli/dashboard/src/lib/components/tabs/MarketplaceTab.svelte
packages/cli/dashboard/src/lib/components/tasks/TaskBoard.svelte
packages/cli/dashboard/src/lib/components/marketplace/McpServersTab.svelte
```

## Files to Create

```
packages/cli/dashboard/src/lib/components/HudPanel.svelte
packages/cli/dashboard/src/lib/components/RarityBadge.svelte
packages/cli/dashboard/src/lib/components/XpBar.svelte
packages/cli/dashboard/src/lib/components/StatBlock.svelte
packages/cli/dashboard/src/lib/components/onboarding/AgentForge.svelte
packages/cli/dashboard/src/lib/components/onboarding/ArchetypeSelect.svelte
packages/cli/dashboard/src/lib/components/onboarding/StartingLoadout.svelte
packages/cli/dashboard/src/lib/stores/onboarding.svelte.ts
```

---

## What This Is NOT

- No parchment textures, wax seals, pixel fonts, or treasure chests (that was v1)  
- No complete visual overhaul — the existing shadcn/svelte component structure is kept  
- No new backend API endpoints needed (all driven by existing data)  
- No breaking changes to existing functionality  

The RPG flavor lives entirely in: vocabulary, color accents, glow effects, and micro-interactions.  
The backbone stays clean modern dashboard. The soul is what makes it feel alive.
