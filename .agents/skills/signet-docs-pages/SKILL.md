---
name: signet-docs-pages
description: "Rewrite or create a public Signet docs page (web/docs) to the house template: verified facts, sequence diagrams, field lists, themed screenshots, hairline figure. NOT for README, specs, or marketing pages."
---

# Signet Docs Pages

Use this workflow to bring a page under `web/docs/src/content/docs/` up to the house template, or to write a new one. Pick the reference page closest to the one you are writing, then read it in source and rendered before you start. When this file and a reference page disagree, the page wins and this file should be fixed.

The template exists because the old pages accumulated one accurate paragraph per pull request until nobody could find the contract. The goal is a page a reader can scan in the order they build: what it is, how it flows, the exact contract, then the edge cases.

## Reference Pages

All paths are under `web/docs/src/content/docs/`. Each was rebuilt with this workflow and approved.

| Page | Type | Shows |
|---|---|---|
| `api/memory/recall-search.mdx` | API reference | Endpoint table, `SequenceDiagram` with process boundary and `opt` frames, `EndpointSpec`, curl/CLI/SDK `Tabs`, `Fields` for request and response, error table, `####` behavior topics, legacy endpoints |
| `quickstart.mdx` | Tutorial | Numbered `##` steps, OS `Tabs` (stable and nightly), sample output from real print statements, a hooks `SequenceDiagram`, troubleshooting table keyed by exact error strings |
| `getting-started/setup.mdx` | How-to guide | Light and dark `Screenshot` per onboarding screen, screen overview table, defaults table, `Fields` for form fields and CLI flags, headless and plan sections, troubleshooting table |
| `desktop-builds.md` | Relocated section | Moving off-topic content to its own page and sidebar entry instead of deleting it |

The primitives live in `web/docs/src/components/`: `Fields.astro`, `SequenceDiagram.astro`, `EndpointSpec.astro`, `HairlineFigure.astro`, and `Screenshot.astro`. Read a component before using a prop this file does not show.

## When to Use

- Rewrite an existing docs page that buries its contract in prose.
- Write a new reference, concept, or how-to page.
- Add a diagram, field list, or figure to an existing page.

## Prerequisites

- Read `web/docs/AGENTS.md`. It holds the visual rules this template depends on.
- Start the dev server: `cd web/docs && bun run dev -- --background --port 4400 --host 127.0.0.1`. Stop it with `bunx astro dev stop`.
- Have a headless browser for screenshots (`agent-browser`, Playwright, or Chrome).

## How to Run

1. **Trace the facts before writing.** Delegate a read-only trace of the real code path to a subagent with file:line citations. For an endpoint, ask for: route and handler, permission and auth failures, every parameter with type, default, and bounds, every error status with its exact body and trigger, the ordered execution path naming which steps cross process boundaries and which are config-gated, the emitted response fields, and the CLI, SDK, and MCP callers. Spot-check its riskiest claims yourself. The existing page is evidence of past intent, not truth.
2. **Separate doc fixes from code problems.** When the trace finds behavior that looks wrong (missing authorization, unscoped reads, a silent filter), document only what a caller needs, keep security gaps out of the public page, and report them to the user as issues to file.
3. **Convert to MDX if needed:** `git mv page.md page.mdx`. Restart the dev server after a rename; it keeps serving the old file otherwise.
4. **Write the page** using the anatomy below for its type.
5. **Verify** with the checks under Proof. Look at every screenshot; do not report a page you have not seen.

## Page Anatomy

### Every page

- An H1 from frontmatter `title`, and a `description` of one sentence.
- An intro of one or two sentences: what this is and when to use it. If the page has a figure, put the intro inside `HairlineFigure`.
- Behavior before mechanics. Say what the caller observes; link to concept pages for internals.
- No changelog prose. Do not describe what the product does not do, what changed in a release, or why a decision was made, unless the reader must act on it.

### API reference

Follow `api/memory/recall-search.mdx`:

1. Intro with figure, then a "which endpoint" table: endpoint (linked to its section), use it for, engine.
2. `## How <operation> runs` with one `SequenceDiagram` for the main endpoint, and one sentence on what happens when the owner fails.
3. One `## METHOD /path` per endpoint, each in this order:
   - one-sentence purpose
   - `EndpointSpec`: Permission, Body, Deadline, Rate limit, Clients (only the rows that apply)
   - `### Example`: `Tabs syncKey="client"` with curl, CLI, and SDK, then a `json title="200 OK"` block with realistic, internally consistent values
   - `### Request` as `Fields`
   - `### Response` as `Fields`, with nested objects as their own `Fields` list after a one-line lead-in
   - `### Errors` as a table: Status, `error`, When
   - `### Behavior` with `####` topics, each a short paragraph and bullets
4. Secondary or legacy endpoints use the same order, shortened. Mark legacy routes and point to the replacement.

### CLI reference

One `##` per command. Purpose sentence, a usage code block, a `Fields` list of flags (head line: `` `--flag` value · default x ``), one or two examples with real output, then exit codes or errors as a table.

### Concept page

Intro with figure, then sections that each answer one question. Use a `SequenceDiagram` for flows between processes and a box-drawing code block for static structure. End with links to the reference pages that implement the concept.

### Tutorial

Follow `quickstart.mdx`. Intro with figure naming the outcome and the time it takes. Numbered `## 1. Verb` steps, each one action, its expected output, and its check. Put platform variants in `Tabs syncKey="os"`. Finish at the point the reader sees the product work, then a troubleshooting table and next steps.

### How-to guide

Follow `getting-started/setup.mdx`. Intro with figure, then the task in the order the reader meets it. For a UI flow, give an overview table of every screen, then one `###` per screen that matters, each with a `Screenshot` and its fields. Put the scripted or headless path after the interactive one. End with a troubleshooting table keyed by the exact error strings.

## Primitives

Import from `~/components/` at any depth.

### `Fields`

A wrapper that styles a plain Markdown list. Each item is a head line, a blank line, then an indented description. Everything after the field names on the head line is plain text (it is already monospace); only names use backticks. Mark required fields with `**required**`.

```mdx
<Fields>

- `query` string · **required**

  Search text. Exact dates start [temporal recall](#dates-in-a-query).

- `since`, `until` ISO 8601

  Bounds on `created_at`.

</Fields>
```

Use tables only for short, uniform rows: errors, enum value groups, client comparison.

### `SequenceDiagram`

Static SVG built at compile time. Keep it to about 15 steps, 3 to 5 participants, and labels under about 28 characters. Use `·` to join short phrases.

```mdx
<SequenceDiagram
	title="Caption that also serves as the accessible name."
	participants={[{ id: "client", label: "Client", sub: "CLI · SDK · MCP" }, ...]}
	boundaries={[{ label: "signet daemon", from: "daemon", to: "owner" }]}
	steps={[
		{ from: "client", to: "daemon", label: "POST /api/..." },
		{ from: "daemon", to: "daemon", label: "self step" },
		{ from: "owner", to: "daemon", label: "result", reply: true },
		{ frame: "opt graph", steps: [ ... ] },
		{ note: "an invariant worth seeing", over: ["owner"] },
	]}
/>
```

Draw process boundaries when the page's behavior depends on them (request process versus database owner). Frames are for config-gated or conditional steps; name the condition (`opt reranker`, `opt sessionKey`).

### `EndpointSpec`

`<EndpointSpec rows={{ Permission: "`recall`", Deadline: "30 s" }} />`. Values accept backtick code and Markdown links.

### `HairlineFigure`

One per page at most, at the top, wrapping the intro. Pick a figure whose object matches the page's subject, and write a `label` that describes the drawing, not the feature.

| Subject | Figures |
|---|---|
| Memory, recall | `riffle`, `drawer`, `cabinet` |
| Search, filters | `loupe`, `sieve`, `query` |
| Secrets, auth | `vault`, `padlock`, `lockers` |
| CLI, terminal | `terminal`, `keyboard` |
| Sources, connectors, harnesses | `plug`, `patch`, `router`, `dish` |
| Graph, ontology | `branches`, `terrain` |
| Pipeline, workers | `slow`, `turntable`, `elevator` |
| Dashboard, UI | `exploded`, `laptop`, `phone` |
| Data, analytics | `plot`, `phosphor` |

The full list is in `node_modules/@lucasmarkes/hairline/README.md`.

### `Screenshot`

Product UI captured in both themes; the page shows the one matching the site theme. Store pairs in `src/assets/screenshots/<page>/` and import them so Astro optimizes them.

```mdx
import Screenshot from "~/components/Screenshot.astro";
import connectionLight from "~/assets/screenshots/setup/connection-light.png";
import connectionDark from "~/assets/screenshots/setup/connection-dark.png";

<Screenshot light={connectionLight} dark={connectionDark} alt="What the screen shows, for someone who cannot see it." />
```

Capture from a throwaway daemon, never the user's live workspace:

1. Bootstrap a scratch workspace with the real setup code (`runDashboardSetupBootstrap` from `surfaces/cli/src/features/setup-fresh.ts`) under `/mnt/work/scratch`.
2. Start the checkout daemon with `HOME`, `SIGNET_PATH`, `SIGNET_PORT=3851`, and `SIGNET_HOST=127.0.0.1` all pointed at scratch, so connectors write into the scratch home. Confirm `/health` reports the scratch `agentsDir`.
3. Run the dashboard with `SIGNET_DAEMON_URL=http://127.0.0.1:3851 bun run dev` in `surfaces/dashboard`.
4. At 1280x800, capture each state twice with `agent-browser set media light` and `dark`. Crop the app rail (`58,34` to the right and bottom edges) and use neutral example data.
5. Stop both processes and delete the scratch workspace.

Full-page screenshots of the docs page show lazy images as blank; scroll the page before judging them.

### Starlight components

`Tabs` and `TabItem` with `syncKey="client"` for client examples. `Aside` only for something the reader must not miss. `Steps` for how-to procedures.

## Writing Rules

- One idea per paragraph. Short declarative sentences in American English.
- State bounds and defaults as numbers next to the field, not in a later paragraph.
- Name the exact error string and the condition that triggers it.
- Keep examples runnable: the default port is `3850`, local auth needs no token, and the SDK client is `SignetClient` from `@signet/sdk`.
- Use **Signet** in prose and `signet` for commands, packages, and paths.

## Proof

Run from `web/docs`:

```text
bun run validate:content
bunx astro check
```

Then screenshot the page at 1440 px and 390 px, in light and dark (`document.documentElement.dataset.theme = "dark"`), and read every slice. Confirm:

- no horizontal page overflow at 390 px (`document.documentElement.scrollWidth <= innerWidth`); only diagrams and wide tables scroll, inside their own containers
- the diagram labels do not collide and the figure renders
- headings follow the site scale (32, 22, 18, 16 px) and nothing on the page overrides it
- every in-page anchor link resolves

Report the facts you corrected against the old page, the code problems you found and did not document, and any check you could not run.
