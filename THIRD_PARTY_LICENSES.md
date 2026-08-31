# Third-party licenses

Signet is released under the [Apache License 2.0](./LICENSE). The dashboard and
the rest of the repository also build on the open-source projects listed below.
This document is the human-readable license colophon for the dashboard shipped
from `surfaces/dashboard`; the exact resolved versions are recorded in
[`bun.lock`](./bun.lock).

Each project remains under its own license. The links in the table point to the
upstream project and its canonical license or notices. When a package groups
more than one npm package, each package is covered by the same license shown in
that row unless the upstream project says otherwise.

## Dashboard dependencies

### Runtime dependencies

| Package | Version range | License | Upstream |
| --- | --- | --- | --- |
| `@fontsource/geist` | `^5.3.0` | SIL Open Font License 1.1 | [Fontsource fonts](https://github.com/fontsource/fonts) |
| `@fontsource/geist-mono` | `^5.3.0` | SIL Open Font License 1.1 | [Fontsource fonts](https://github.com/fontsource/fonts) |
| `@radix-ui/react-slot` | `^1.1.2` | MIT | [Radix Primitives](https://github.com/radix-ui/primitives) |
| `@shadcn/react` | `^0.2.1` | MIT | [shadcn/ui](https://github.com/shadcn-ui/ui) |
| `class-variance-authority` | `^0.7.1` | Apache-2.0 | [cva](https://github.com/joe-bell/cva) |
| `clsx` | `^2.1.1` | MIT | [clsx](https://github.com/lukeed/clsx) |
| `lucide-react` | `^1.26.0` | ISC | [Lucide](https://github.com/lucide-icons/lucide) |
| `next-themes` | `^0.4.6` | MIT | [next-themes](https://github.com/pacocoursey/next-themes) |
| `radix-ui` | `^1.6.5` | MIT | [Radix Primitives](https://github.com/radix-ui/primitives) |
| `react` | `^19.2.0` | MIT | [React](https://github.com/facebook/react) |
| `react-dom` | `^19.2.0` | MIT | [React](https://github.com/facebook/react) |
| `sonner` | `^2.0.7` | MIT | [Sonner](https://github.com/emilkowalski/sonner) |
| `tailwind-merge` | `^3.6.0` | MIT | [tailwind-merge](https://github.com/dcastil/tailwind-merge) |
| `three` | `^0.185.1` | MIT | [three.js](https://github.com/mrdoob/three.js) |
| `yaml` | `^2.9.0` | ISC | [yaml](https://github.com/eemeli/yaml) |

### Build and verification dependencies

These packages are used to build, type-check, or test the dashboard. They are
listed here because their code may participate in the generated distribution or
in the development workflow even though they are not runtime imports.

| Package | Version range | License | Upstream |
| --- | --- | --- | --- |
| `@tailwindcss/vite` | `^4.2.0` | MIT | [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) |
| `@types/react` | `^19.2.0` | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react-dom` | `^19.2.0` | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/three` | `^0.185.3` | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/yaml` | `^1.9.7` | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@vitejs/plugin-react` | `^5.2.0` | MIT | [Vite](https://github.com/vitejs/vite) |
| `happy-dom` | `^20.11.1` | MIT | [Happy DOM](https://github.com/capricorn86/happy-dom) |
| `tailwindcss` | `^4.2.0` | MIT | [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) |
| `tw-animate-css` | `^1.4.0` | MIT | [tw-animate-css](https://github.com/Wombos584/tw-animate-css) |
| `typescript` | `^5.9.3` | Apache-2.0 | [TypeScript](https://github.com/microsoft/TypeScript) |
| `vite` | `^7.3.6` | MIT | [Vite](https://github.com/vitejs/vite) |

## License references

The canonical texts for the licenses used by the dashboard are available from
the following project-maintained sources:

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [MIT License](https://opensource.org/license/mit)
- [ISC License](https://opensource.org/license/isc-license-txt)
- [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/)

This inventory is maintained alongside the dashboard manifest. When a direct
dependency, version range, or license changes, update this document in the same
change and verify the resolved package metadata in `bun.lock`.
