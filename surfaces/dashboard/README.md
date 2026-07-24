# signet-dashboard

Web dashboard for Signet. React 19 + Vite + React Router v7 (data router) +
shadcn/ui + Tailwind v4 + `next-themes`. See issue #948 for the full rewrite
contract and milestone plan.

## Build contract (do not change without updating the daemon + Electron)

`bun run build` emits static assets to **`build/index.html`** (Vite
`build.outDir: "build"`, `base: "/"`). Three consumers key off that path:

- `scripts/prepare-dashboard-bundle.ts` — copies `build/` into a target package.
- `platform/daemon/src/routes/dashboard.ts` — serves `build/` with SPA fallback
  to `index.html` (dev path + published `dashboard/` paths).
- `surfaces/desktop/src/main.ts` — serves `dashboardRoot()` over the privileged
  `app://signet/` scheme with the same SPA fallback; `/health`, `/api/*`,
  `/memory/*` are proxied to the daemon.

## Design system

`src/index.css` is the single source of truth, lifted from
`web/marketing/public/redesign-home-mockup.html`. Light is `:root`, dark is the
`.dark` class (next-themes `attribute="class"`). One-off `color-mix()` overlays
from the mockup are promoted to named tokens (`--hover-overlay`,
`--active-overlay`, `--accent-subtle`, `--border-glow`).

Geist / Geist Mono are self-hosted via `@fontsource` so the sandboxed Electron
renderer works offline.

## Scripts

```bash
bun install
bun run dev        # Vite dev server (proxies /api, /health, /memory to the daemon)
bun run build      # tsc --noEmit && vite build → build/index.html
bun run typecheck  # tsc --noEmit
bun run preview    # serve the production build
```
