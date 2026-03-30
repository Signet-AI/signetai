---
name: signet-design
description: >
  Signet's visual design system — technical/industrial monochrome aesthetic
  with generative halftone art, geometric icon set, dual dark/light themes.
  Use when building or modifying UI for Signet products (website, dashboard,
  docs, pitch decks, component libraries). Covers design tokens, typography
  pairing, icon system, component patterns, generative dithering, and layout
  principles. Trigger on any Signet frontend work, design brief updates, or
  brand-aligned UI tasks.
---

# Signet Design System

See `assets/design-brief.png` for a full-page reference screenshot.

## What Signet Is

Signet is the layer that takes an LLM from a stateless autocomplete
algorithm to a real individual with opinions, persistence, and skills.
It is a portable, user-owned standard for agent identity — your
configuration, memory, personality, and skills travel with you across
platforms. No single company or harness owns your agent. Your agent
is yours.

Memory isn't just recall. It's coherence. An agent running across
multiple sessions on different platforms is still one agent. Experiences
branch and merge like version control — same history, different heads,
converging back into a single identity. Corrigibility is built in, not
bolted on. The trust layer keeps track of mistakes and works to ensure
they never happen again.

The design system reflects this philosophy: technical, industrial,
honest. Nothing soft or friendly. Nothing that hides the machinery.
Signet's UI should feel like looking at a live system — a mind that
persists, not a product that sells.

## Aesthetic Direction

Technical. Industrial. Near-monochrome. The visual language draws from
blueprint schematics, CRT flight terminals, cyberpunk interfaces,
1-bit halftone print, and rave poster aesthetics. It is NOT consumer
SaaS, NOT Material Design, NOT soft/friendly.

Core principles:
- **Dual typeface** — Chakra Petch (display) + IBM Plex Mono (body)
- **Near-monochrome** — desaturated grays, almost no color accent
- **Zero border-radius** — sharp 90-degree corners everywhere
- **Outlined over filled** — stroked buttons, stroked badges
- **System naming** — underscore convention: `Sys_Palette`, `Component_Library`
- **Geometric icons** — inline SVG, stroked primitives, 24x24 viewBox
- **Registration marks** — crosshair (+) elements as visual punctuation
- **Generative texture** — Bayer-dithered halftone art as bold compositional elements
- **Dual theme** — dark (near-black) and light (warm beige cream)
- **Background opacity 0.8** — all overlay elements (connectors, nodes,
  schematic circles) sit at 80% opacity to recede behind content

## Anti-Patterns

These violate the design system. Never do:
- **Border-radius** — no rounded corners, no pills, no circles on
  containers. Only exception: schematic decorator circles.
- **Filled buttons at rest** — buttons are always outlined, fill only
  on hover (invert).
- **Generic fonts** — no Inter, Roboto, Arial, system-ui. Only Chakra
  Petch and IBM Plex Mono.
- **Serif fonts** — never. Too editorial, too warm.
- **Saturated color** — no bright blues, greens, purples. The palette
  is desaturated gray with muted danger/success accents only.
- **Purple gradients** — the quintessential AI slop aesthetic. Banned.
- **Soft/friendly UI** — no rounded icons, no emoji glyphs, no pastel
  tones, no bouncy animations.
- **Opacity on muted text** — use `--color-text-muted` directly,
  never layer `opacity: 0.5` on top of already-muted colors.
- **Pure white backgrounds** — light theme uses warm beige `#e4dfd8`,
  never `#ffffff`.
- **Single-font hierarchy** — always pair display + mono. Using one
  font for everything flattens the hierarchy.
- **Attention-grabbing animation** — no bounce, no scale-up entrances,
  no flash effects. Ambient only.
- **S-curves or multi-inflection connector lines** — connectors use
  single-curve quadratic beziers. Never cubic with two control points.

## Typography

Two typefaces with distinct roles. This pairing creates hierarchy
through contrast between condensed geometric headings and fixed-width
body text.

### Chakra Petch — Display
- Google Fonts: `family=Chakra+Petch:wght@400;500;600;700`
- Role: headings, hero titles, card titles, inverted labels
- Semi-condensed geometric sans with a technical edge
- Weights: 600 for headings, 700 for hero display
- Always uppercase with wide letter-spacing (0.04–0.08em)
- Hero titles: 3.5–4rem, weight 700, line-height 0.9

### IBM Plex Mono — Body
- Google Fonts: `family=IBM+Plex+Mono:wght@400;500;600`
- Role: body text, code, labels, buttons, inputs, badges, metadata
- Clean readable monospace for the functional layer
- Weight 400 for body, 500 for labels/buttons, 600 for emphasis

CSS variables:
```css
--font-display: 'Chakra Petch', sans-serif;
--font-mono: 'IBM Plex Mono', monospace;
```

## Design Tokens

See `assets/globals.css` for the full token set. All tokens use CSS
custom properties that flip between themes via `[data-theme]`.

### Dark theme (default)
```
--color-bg: #08080a          --color-dither: #f0f0f2
--color-surface: #0e0e12     --color-border: rgba(255,255,255,0.06)
--color-surface-raised: #151519
--color-text: #d4d4d8         --color-border-strong: rgba(255,255,255,0.12)
--color-text-bright: #f0f0f2
--color-text-muted: #3e3e46   --color-accent: #8a8a96
```

### Light theme
```
--color-bg: #e4dfd8          --color-dither: #0a0a0c
--color-surface: #dbd5cd     --color-border: rgba(0,0,0,0.06)
--color-surface-raised: #d1cbc2
--color-text: #2a2a2e         --color-border-strong: rgba(0,0,0,0.12)
--color-text-bright: #0a0a0c
--color-text-muted: #7a756e   --color-accent: #6a6660
```

Light background is warm beige, never pure white. Borders flip from
white-alpha to black-alpha. Dither dots flip color via `--color-dither`.

Readability: light mode `--color-text-muted` must be dark enough for
legible text on the beige surface (~3.5:1 contrast min).

## Icon System

12 geometric inline SVG icons built from primitives. All use 24x24
viewBox, 1.5px stroke, square linecap, miter join. Stroked (not
filled) unless semantically solid (burst, grid dots).

Icons: `target`, `node`, `signal`, `split`, `diamond`, `grid`,
`chevron`, `burst`, `eye`, `lock`, `link`, `orbit`

```html
<span class="icon"><svg viewBox="0 0 24 24">...</svg></span>
<span class="icon icon--sm">...</span>  <!-- 16px -->
<span class="icon icon--lg">...</span>  <!-- 32px -->
```

CSS sets `stroke: currentColor` so icons inherit text color and
adapt to theme automatically. See `assets/index.html` for all SVG
paths.

Design language: circles with crosshairs, concentric rings,
radiating nodes, split shapes, rotated squares, dot matrices.
Match the abstract geometric style — never use rounded friendly
icons or filled emoji-style glyphs.

## Component Patterns

### Buttons
All outlined, never filled at rest. Fill on hover (invert colors).
Four variants: primary, secondary, ghost, danger. Corner tick marks
(L-bracket `::before`/`::after` pseudo-elements) at top-left and
bottom-right provide registration mark detail. Marks are 5px (4px
on `.btn-sm`), positioned at -1px offset. Mark color matches variant
and brightens on hover. `transform: translateY(1px)` on `:active`.

```css
.btn::before { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
.btn::after { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
```

### Cards & Surfaces
`--color-surface` background, `--color-border-strong` stroke, no
radius. Corner registration marks (8px L-brackets via `::before`/
`::after`) mirror the button pattern at larger scale. Hover
brightens/darkens border and corner marks.

Variants:
- `.card--accent` — 2px top border in `--color-text-muted`, brightens on hover
- `.card-meta` — flex row with border-bottom separator for metadata
  (node ID, status with inline icon). 0.5rem uppercase mono text.
- `.card-grid` — auto-fill grid layout, `minmax(280px, 1fr)`

Cards should contain Signet-relevant content (agent identity, auth
layers, node status) with inline icon + button combinations.

### Badges
Stroked containers with monospace text. `.badge-accent` variant
uses bright text + bright border. Can include inline icons.

### Inputs
Monospace, surface background, strong border. Focus brightens border
and adds 1px `box-shadow` ring. Select uses custom SVG chevron
background-image. `border-radius: 0` always.

### Section Panels
Content sections wrap in `.section-panel` — `--color-surface` bg,
`--color-border` stroke, 6px corner L-bracket registration marks
via `::before`/`::after`. Elevates content above the background
layers.

### HUD / Reticle Blocks
For hero sections or high-emphasis areas, use technical HUD styling:
- Expand padding (`--space-2xl`) to give text breathing room
- `border-left` and `border-bottom` only (creates an open bracket feel)
- `::before`/`::after` pseudo-elements to create 5x1px crosshair ticks at the bottom-right and top-left corners
- Add a top-right 5x1px tick (`.hero-content-tick`) to complete the bounding box
- Subtle `135deg` linear gradients (e.g., `rgba(255, 255, 255, 0.02)` to `transparent 50%`) instead of solid fills to let dithered backgrounds show through

### Terminal Subtitles
For subtitles under hero text or major headings:
- Use `var(--font-mono)`, uppercase, and underscore naming (`CORE_UI_PRIMITIVES`)
- Prefix with a command-line prompt (`> `) via a `::before` pseudo-element
- Use `var(--color-accent)` for the text and `var(--color-text-muted)` for the prompt prefix

### Metadata Grids (Spec Sheets)
For displaying key/value pairs or metadata blocks:
- Use strict CSS Grid (`grid-template-columns: repeat(4, 1fr)`) instead of loose flex layouts
- Apply a solid border around the entire grid container
- Use `border-right` on items to create a rigid, technical "spec sheet" data table look
- Set the background to solid `var(--color-surface)` so text pops against complex dithered backgrounds

### Swatches (Color Chips)
For displaying color palettes:
- Design swatches to look like physical color chips from a technical manual
- Wrap the color block and text in a bordered container with padding and a dark background (`var(--color-bg)`)
- Use a `4:3` aspect ratio for the color block instead of a perfect square
- Hover effects should be structural (`transform: translateY(-2px)`) with a border highlight, rather than bouncy scales

### Decorative Elements
- Crosshair marks (`.crosshair`) — 10px, muted color
- 4-pointed star (`.star-4`) — clip-path polygon
- Schematic circles — stroked circles with centered crosshairs,
  `opacity: 0.8`, `node-pulse` animation
- Corner star markers (`****`) — mono text, positioned absolute
- Vertical sidebar text (`writing-mode: vertical-rl`, `transform: rotate(180deg)`)
- Numbered index grids (00–23 in 8-column grid)
- Inverted labels (`.label-inv`) — bright bg, dark text, no radius
- **CSS Barcodes** — `.barcode` using `repeating-linear-gradient` with muted text colors for industrial artifacts
- **Hex Dump Streams** — `.hex-stream` displaying memory addresses (`0x0000`), hex data, and ASCII translations to reinforce the agent memory theme
- **SVG Noise Grain** — `.page::before` or `body::before` with `feTurbulence` (fractalNoise) at very low opacity (0.04) to create a CRT/industrial texture overlay

## Embedding Graph Overlay

A background layer of interconnected crosshair nodes arranged as
an embedding/vector-space visualization. Inspired by Detroit
Underground record sleeve schematics.

### Node Layout
16 crosshair nodes (`#ch-0` through `#ch-15`) in 4 clusters plus
outliers, positioned with `position: absolute` percentages:

- **Cluster A** (upper-left, near `#sc-1`): ch-0 through ch-3
- **Cluster B** (upper-right, sparse): ch-4, ch-5
- **Cluster C** (mid-left, near `#sc-2`): ch-6 through ch-8
- **Cluster D** (lower region): ch-9 through ch-12
- **Outliers**: ch-13, ch-14, ch-15 (bridge nodes between clusters)

3 hub nodes as larger schematic circles (`#sc-1`, `#sc-2`, `#sc-3`)
with crosshair pseudo-elements and `node-pulse` animation.
3 star markers (`#sm-1`, `#sm-2`, `#sm-3`) as `****` text.

### Edge Topology
Edges defined as `[fromId, toId, style, label?]` array:
- **Intra-cluster** — short connections within each cluster
- **Inter-cluster bridges** — longer connections between clusters,
  labeled with embedding metrics (`cos=0.74`, `d=0.12`)
- **Hub connections** — edges from crosshair nodes to schematic
  circles and star markers

### Connector Rendering
JS-drawn SVG overlay. On load (and resize), reads
`getBoundingClientRect` centers of all nodes, then draws
**quadratic bezier curves** (`Q` command) between them:

```js
const dx = b.x - a.x, dy = b.y - a.y;
const mx = (a.x + b.x) / 2 + dy * 0.12;
const my = (a.y + b.y) / 2 - dx * 0.12;
path.setAttribute('d', `M ${a.x},${a.y} Q ${mx},${my} ${b.x},${b.y}`);
```

Single control point offset 12% perpendicular from the midpoint.
This produces exactly one gentle arc per line — never S-curves.

Connector styles:
- `conn-dashed` — `stroke-dasharray: 4 6`, animated `dash-flow` 15s
- `conn-dashed-rev` — same dash, reverse direction 15s
- `conn-dot` — 2.5px radius circles at each endpoint, filled with surface color and stroked with text color (hollow port look)
- `conn-packet` — small (1.5px) circles animated along the path using `<animateMotion>` with randomized durations and delays to simulate live data flow. Packets should be filled with `--color-text-muted` and have no drop shadow by default so they act as subtle ambient blips rather than bright tracer rounds.
- `conn-label` — 7px mono text near midpoint (`d=0.12`, `cos=0.74`)
- Base connector lines render at `opacity: 0.3` so data packets pop slightly

### Node Hover Interaction
Crosshair nodes have `pointer-events: auto` (rest of the field is
`pointer-events: none`). On hover:

1. **Crosshair expansion** — `::before`/`::after` pseudo-elements
   scale 1.8x on their respective axes, color brightens to
   `--color-text`
2. **Rich HUD Tooltip (`.ch-label`)** — mini-panel appears above node.
   - Styled with padding, `--color-surface` background, strong border, and a drop shadow
   - Includes a 1x4px stem line (`::before`) connecting the panel to the node
   - Content is dynamically injected HTML: slot name in brackets, `STS: ACTIVE`, and a randomized hex memory address (`MEM: 0x4F2A`)
3. **Mechanical Lock-On Ring (`.ch-ring`)** — dashed ring snaps into place.
   - Starts at `-45deg` rotation and `0.5` scale
   - On hover, uses a snappy cubic-bezier (`cubic-bezier(0.16, 1, 0.3, 1)`) to animate to `0deg` and `1.0` scale
   - Once locked, begins a slow, continuous 10s rotation to indicate an active lock
4. **Connected edge highlight** — JS builds adjacency map from
   edge list. On hover, all SVG elements belonging to connected
   edges (grouped via `<g>`) get `.conn-highlight` class: stroke brightens to
   `--color-text`, width increases to 1.5px, hollow ports fill in, and data packets enlarge, turn bright (`--color-text-bright`), and gain a drop shadow.
5. **On mouseleave** — all `.conn-highlight` classes removed

## Generative Art

Dithered canvas art is structural — bold compositional anchors.
See `references/generative-patterns.md` for full implementation.

Canvas layers:
1. **Hero zone** — organic blobs from edges (opacity 0.35)
2. **Right edge bleed** — fixed 240px vertical canvas (opacity 0.18)
3. **Bold dither blocks** — 80–160px, full opacity 0.8, glitch mode
4. **Section dither bands** — 80px strips, band/cloud variants

Dither modes: organic, glitch/smear, band, cloud.
Pipeline: Seeded Perlin → fbm → Bayer 4x4 → canvas fill.
Use `--color-dither` so canvases adapt to theme.

## Depth & Layering

Multiple overlapping layers create spatial depth, inspired by
flight terminal / CRT interface aesthetics:

1. **SVG noise grain** — `body::before`, fixed, z-index 9999
   (0.04 opacity), using `feTurbulence` filter for CRT texture
2. **Blueprint Grid** — fixed background layer with a 32x32px CSS linear-gradient grid (`.bg-grid`). Apply a `radial-gradient` mask to fade it out toward the edges.
3. **Bleed typography** — massive text (12–20rem) bleeding off
   viewport edges, 2.5% opacity, `--font-display`
4. **Targeting Zones (Floating panels)** — translucent rectangles drifting ±3–4px over 40–65s cycles. Use nearly transparent gradients (`rgba(255, 255, 255, 0.01)`) and corner tick marks instead of solid fills to act as HUD brackets.
5. **Metadata fragments** — scattered timestamps, coordinates,
   version codes in 7px mono text. Use brackets `[ ]`, plus signs `+`, and command prompts `>` to reinforce the terminal aesthetic.
6. **Embedding graph** — crosshair nodes + quadratic bezier
   connectors at 80% opacity (see section above)
7. **Schematic overlay** — circles with crosshairs, star markers. Hub circles should include a dashed inner ring (`.sc-inner`) with a slow (20-30s) linear infinite rotation.
8. **Right edge dither** — 240px canvas strip, organic noise
9. **Section panels** — content wrapped in `--color-surface`
   panels with corner registration marks
10. **Hex Dump Streams** — raw memory representations overlaid as
    structural blocks (`.hex-stream`)

## Animation & Interaction

All animations are subtle and ambient — never attention-grabbing.
The goal is to create the feeling of a live, breathing system
dashboard.

### Ambient (CSS keyframes)
- **Floating panel drift** — `fp-drift` 40–65s ease-in-out infinite
  alternate. Panels translate ±3–4px. Stagger with `animation-delay`.
- **Metadata flicker** — `mf-flicker` 7–15s. Brief opacity dip to
  simulate data refresh. Stagger child delays.
- **SVG connector dash flow** — `dash-flow` / `dash-flow-rev` on
  `stroke-dasharray: 6 4` paths, 12–15s linear infinite.
- **Schematic node pulse** — `node-pulse` 5–8s, scale 1→1.04 and
  opacity 1→0.7 on hub circles with crosshairs.
- **Scan line sweep** — 1px horizontal gradient line sweeps top to
  bottom every 15–25s at 0.06 opacity. Triggered via JS setTimeout.

### Interactive (JS + CSS transitions)
- **Scroll reveal** — `.reveal` class, `IntersectionObserver` with
  `threshold: 0.08`. Fade+translateY(12px→0), 0.6s ease-out.
  Above-fold elements stagger with 80ms delay increments.
- **Cursor coordinates** — fixed `div` follows mouse, shows
  `x: # y: #` in 7px mono, fades to 0 after 2s idle.
- **Node hover** — crosshair expansion + ring pulse + SLOT label +
  connected edge highlighting (see Embedding Graph section).
- **Icon hover coordinates** — CV-debug-style `x:### y:###` label
  at top-right of icon cells, green color (`--color-success`),
  fades in on hover. Icon SVGs scale 1.12x.
- **Swatch hover** — scale 1.08x with 1px outline ring.
- **Input focus glow** — 1px `box-shadow` ring on focus.

### Animation Anti-Patterns
- No bounce or spring animations
- No scale-up entrance effects
- No flash/blink effects
- No parallax scrolling
- Durations always > 5s for ambient, 0.2–0.6s for interactive
- Never `animation-iteration-count: 1` for ambient effects

### Ambient Data Streams
For elements representing live data or memory (like Hex Dumps):
- Use slow, linear, infinite vertical translation (`transform: translateY(-50%)` over 20-30s)
- Duplicate content within an inner wrapper to create a seamless loop
- Apply a linear gradient mask (`::after` pseudo-element) that fades to the background color at both the top and bottom to create a smooth entry/exit point for the streaming data

## Layout Principles

- Max content width: ~820px, centered
- Hero: min-height 380px, dithered canvas bg, metadata bar below title
- Asymmetric offsets (form inputs pushed right)
- Section indices (01/07, 02/07) in section headers
- Labeled dividers between logical section groups
- Fixed sidebar with vertical text on left
- Background crosshair field at low opacity
- Generous section spacing (`--space-xl`)
- Bold dither blocks between sections as visual weight

## Theme Toggle

`data-theme` attribute on `<html>`. Toggle button fixed top-right.
On toggle: update attribute, re-render all canvas dither art after
60ms delay (so CSS variables update).

## Resources

- `assets/design-brief.png` — Full-page reference screenshot of
  the design brief with all components and background layers.
- `assets/globals.css` — Complete token stylesheet with dual themes,
  typography, components, icon classes, and utilities.
- `assets/index.html` — Full reference implementation with all
  components, icon set, generative art, embedding graph, theme toggle.
- `references/generative-patterns.md` — Perlin noise + fbm + Bayer
  dither + glitch smear implementation with code.
