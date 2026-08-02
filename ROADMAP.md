Roadmap
===

Updated 2026-07-23. This gets updated as priorities shift.

What the markers mean: `[done]` shipped, `[wip]` working on it now, `[next]` next in line, `[backlog]` want to do it but not yet scheduled.

---

What we're building now

---

The core memory system works. The pipeline drains. Recall is fast. What's missing is the part where normal people can install it and not feel lost.

**[wip] Dashboard redesign (#948)**

The old dashboard was never given a proper design pass. It grew piece by piece without a plan. We're replacing it completely.

The new one is React 19 with shadcn/ui and Geist fonts. One design, light and dark mode, system-default. The design is already locked -- there's an HTML mockup at `surfaces/dashboard/redesign-home-mockup.html`. The React build has to match it pixel for pixel. First milestone proves the build works inside Electron. After that, every page gets rebuilt: home, memory browsing, settings, harness config, sources, journal.

**[wip] Desktop app (#1001)**

Right now Signet is a command-line tool. That works for developers. It doesn't work for everyone else.

The desktop app is an Electron shell that wraps the same compiled binary headless installs use. It manages the daemon in the background, shows a tray icon, and updates itself. Ships as .dmg, .exe, and .AppImage from GitHub releases. No app store.

Headless installs (`npm i -g signetai`, curl-install) still work. The data lives in `~/.agents/` no matter how you install it, so switching from headless to desktop is seamless -- the desktop app detects your existing setup and adopts it.

**[wip] Config system that doesn't suck**

The router blocks targets with opaque error messages. The privacy check for local models is broken. Old config fields get left behind after migration. These all came up during real use and need to be fixed before the settings panel in the dashboard can ship.

**[next] Setup wizard (#967)**

New users shouldn't have to hand-edit a YAML file to get started. The wizard walks through harness connections, inference targets, and workspace setup.

**[next] Transcript export (#984)**

Export session transcripts in a format suitable for training. Powers the dataset work below.

---

Making the pipeline coherent

---

Extraction works, but the architecture between the pipeline and dreaming is tangled. Both should draw from the same queue and produce the same kind of graph changes, so users can pick whichever approach fits their hardware.

**[wip] Unify pipeline and dreaming (#913)**

One queue for everything -- summaries, transcripts, imported content. Pipeline distillation and agentic dreaming both read from it and write to the same graph operations. You turn one on, you turn the other off, or you run both. The system doesn't care.

**[next] Dreaming as a proper agent inside the daemon (#947 B)**

Pi is a TypeScript library that gives us auth, model selection, and 30+ providers out of the box. Embedding it in the daemon means the dreaming agent gets real graph tools and produces runbook logs. Replaces the current fragile chain of five separate LLM calls with a single agent that can wander the graph, check its assumptions, and write back.

**[next] Temporal claims (#945)**

When someone saves "going to Venezuela in March," the system should remember to follow up when March passes. A `review_after` timestamp on the memory makes this possible without scanning everything.

**[next] Cross-agent notifications (#944)**

Messages that jump between agent sessions in different harnesses without polling. Each harness declares which hooks it exposes. The module routes through the next available one.

---

Cloud, scale, and the long tail

---

The cloud is not a replacement for the local product. It's optional infrastructure the daemon connects to if you want it. The app is free and local. You pay for sync and hosted services on top. Same model as Obsidian.

**[backlog] Cloud inference API (#647, #1001)**

Background pipeline tasks run on cloud GPUs instead of your local machine. Small free monthly allowance. Paid tier (~$4-8/mo) for more. Separate private repo.

**[backlog] Cross-device sync**

Memory, config, and sources sync between your machines. The daemon opens an outbound connection to the relay. No firewall issues.

**[backlog] Full hosted daemon**

The daemon runs in the cloud so your background pipeline keeps going even when your laptop is closed. Not for v1.

**[backlog] Training dataset and reasoning model**

Fine-tune a small reasoning model from 20k collected conversations. PII sanitized. Mythos-style reasoning traces for extraction and synthesis. Open source the dataset.

---

Operations

---

**[wip] Strict quality gates (#919)**

Make lint, typecheck, and test gates mandatory across TypeScript and Rust. Clear the backlog so the gate can go hard-required.

**[wip] Release pipeline**

Nightly releases produce all three distribution artifacts (npm package, compiled binary, desktop installer). Non-blocking CI.

**[next] Status clarity (#908)**

Status currently mixes up configured, resolved, effective, and running states. Needs to be cleaner.

**[next] Raspberry Pi target (#921)**

Test and optimize for Pi 3B+. Target idle RSS under 100MB.

---

Recently shipped

---

- **[done]** Inference cutover to pi-ai + ACPX (#947 / #949). All hand-rolled providers deleted. -5853 lines of code.
- **[done]** Distribution model spec (#1001). Three install shapes, cloud architecture, locked.
- **[done]** Dashboard redesign HTML mockup. The design spec for the React rewrite.
- **[done]** Multi-agent support baseline.
- **[done]** Connector expansion (Hermes Agent, OpenClaw).
- **[done]** Readable changelog and release notes.
- **[done]** Recall alignment across CLI, MCP, SDK, and hooks.
- **[done]** Documentation site improvements.

---

What changed from the old roadmap

The old roadmap talked about "skills over substrate," "source events as agent triggers," and a "proving-ground loop." Those aren't wrong directions, but they're not what we're shipping right now. What we're shipping is a dashboard that doesn't confuse people, a desktop app that installs like a real application, and a pipeline that doesn't need hand-holding. Once those are solid, the bigger ideas have a foundation to land on.
