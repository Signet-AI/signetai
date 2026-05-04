# Signet Dashboard

Svelte 5 + Vite dashboard bundled with the Signet daemon. The production build
is static and served by `@signet/daemon` at `http://localhost:3850`.

## Development

Install dashboard dependencies from this package directory:

```sh
bun install
```

Run the Vite development server:

```sh
bun run dev
```

The dev server proxies `/api`, `/health`, and `/memory` requests to the local
daemon on port 3850, so start the daemon separately when testing live data:

```sh
signet daemon start
```

## Build

```sh
bun run build
```

The root workspace also builds the dashboard through:

```sh
bun run build:dashboard
```

## Check

```sh
bun run check
```

This runs `svelte-kit sync` and `svelte-check` with the local
`tsconfig.json`.
