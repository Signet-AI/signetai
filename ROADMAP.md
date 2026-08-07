Roadmap
===

Updated 2026-08-03. This gets updated as priorities shift.

What the markers mean: `[done]` shipped, `[wip]` working on it now, `[next]` next in line, `[backlog]` want to do it but not yet scheduled.

---

Stop the bleeding

---

The daemon has to be boring before anything else ships. Sustained ingestion exposed a class of failures — crash loops, silent backlogs, repair tooling that lies about its own results — that erode the one thing Signet sells: trust that your context is safe.

**[wip] Backlog death spiral (#1059, P0)**

Under sustained ingestion the daemon enters a self-sustaining crash loop: backlog grows, retries pile up, the daemon falls over, restart makes it worse. This is the single most important open issue.

**[wip] Hook process leak regression (#1061)**

#890 regressed on v0.157.3 — hook processes leak again, ~800 MB each.

**[next] Repair tooling honesty (#1048, #1050–1053)**

Status and doctor hide an unhealthy dead-job backlog. Queue repair reports daemon failure with exit code 0. Invalid `--tables` falls through to the broad both-queue default. Requeue starves summary jobs. `--max-batch` treated as a per-queue cap. If the repair tools can't be trusted, nothing can.

**[next] Install and update hygiene (#1060, #1044, #1045)**

Auto-updater recreates the npm symlink that doctor then flags. Invalid CLI commands and doctor targets exit successfully. Dashboard command falsely reports starting a healthy daemon. Small, but they're the first commands a new user runs.

**[next] Session TTL eviction (#902)**

Eviction drops tracker state without checkpoint or finalization.

**[wip] Strict quality gates (#919)**

Mandatory lint/typecheck/test across TypeScript and Rust. Baseline PRs are open (#1034–#1037). Once the backlog above clears, the gate goes hard-required.

---

What we're building now

---

The core memory system works. What's missing is the part where normal people can install it and not feel lost.

**[wip] Dashboard redesign (#948)**

The old dashboard was never given a proper design pass. The new one is React 19 with shadcn/ui and Geist fonts, one design, light and dark mode. The design is locked — HTML mockup at `surfaces/dashboard/redesign-home-mockup.html` — and M1 (contract scaffold + surfaces) is open as PR #1022. The React build matches the mockup pixel for pixel. After M1 lands inside Electron, every page gets rebuilt: home, memory browsing, settings, harness config, sources, journal. Known polish items: #1046, #1047.

**[wip] Desktop app (#1001)**

The distribution spec is locked: three install shapes. The desktop app is an Electron shell around the same compiled binary headless installs use — manages the daemon, tray icon, self-updates, ships as .dmg / .exe / .AppImage from GitHub releases. No app store. Headless installs keep working; data lives in `~/.agents/` either way, so the desktop app detects and adopts an existing setup.

**[next] Setup wizard (#967)**

New users shouldn't hand-edit YAML. The wizard walks harness connections, inference targets, and workspace setup — and it unblocks the settings panel in the new dashboard.

**[next] Transcript export (#984)**

Export session transcripts in a training/fine-tuning format from the CLI. Powers the dataset work below.

---

One memory engine

---

Episodic evidence now has one shared aggregation path. Dreaming is the only
automatic semantic writer; document ingestion, summaries, retention, and
source-native topology remain separate non-semantic responsibilities.

**[wip] Unify pipeline and dreaming (#913)**

One selector covers summaries, transcripts, imported content, compactions, and
explicit episodic memory. Dreaming reasons over that evidence and applies
audited graph operations; semantic-first retrieval remains available over the
derived layer.

**[wip] Dreaming as a proper agent inside the daemon (#947 B)**

Dreaming now uses the daemon router with isolated Pi AgentSessions and scoped
ACPX MCP sessions. Remaining work is quality evaluation, live scope-matrix
proof, and safe boundary splitting for oversized evidence.

**[next] Temporal claims (#945)**

"Going to Venezuela in March 2027" should become "should have gone" when March passes — without claiming it happened. Minimal schema change: a nullable `review_after` on memories, set by the dreaming pass when it creates a temporal claim, picked up on later passes, superseded with retrospective framing. Agents can also set expiry explicitly at save time on any surface. Works identically under pipeline dreaming and agentic dreaming.

**[next] Cross-agent notifications (#944)**

Next-available-hook delivery between agent sessions in different harnesses, without polling. Each harness declares its notification-compatible hooks; the module routes through the next available one.

**[next] Recall search strengthening**

Memory search doesn't read entity aliases or community detection yet. Session-start injection no longer skews rehearsal boost (#972, shipped); the remaining work is wiring the ontology signals into ranking.

---

Cloud, scale, and the long tail

---

The cloud is optional infrastructure the daemon connects to if you want it. The app is free and local. You pay for sync and hosted services on top. Same model as Obsidian.

**[backlog] Cloud inference API (#647, #1001)**

Background pipeline tasks on cloud GPUs. Small free monthly allowance, paid tier (~$4–8/mo). Separate private repo.

**[backlog] Cross-device sync**

Memory, config, and sources between your machines. Outbound connection to a relay, no firewall issues.

**[backlog] Full hosted daemon**

The daemon in the cloud so the pipeline runs while your laptop is closed. Not for v1.

**[backlog] Training dataset and reasoning model**

Fine-tune a small reasoning model from collected conversations (#984 feeds this). PII sanitized. Open source the dataset.

**[backlog] Raspberry Pi target (#921)**

Pi 3B+ as minimum platform, idle RSS under 100 MB. Constrained ARM edge runtime PR open (#999).

**[done] Usage analytics (#1026)**

PostHog, non-intrusive, for understanding install and usage patterns. Anonymous
telemetry on by default (opt-out via `telemetryEnabled: false`): per-install
anonymous id, install counter, daemon lifecycle events, and an open JSONL
audit log.

---

Trust and adoption

---

The July competitive audit's conclusion: Signet's engineering is easier to trust than Signet itself. Closing that gap is product work, not marketing fluff.

**[next] Surface the real proof points**

The homepage leads with an 8-question LoCoMo sample while the defensible LongMemEval result (run on Supermemory's own MemoryBench harness, vendored in `memorybench/`) is buried in the docs. Surface the strong number with methodology next to it, or pull the weak one.

**[next] Team, about, and pricing pages**

We ask users to run a persistent daemon with access to their secrets, and the site says nothing about who is behind it. That's the biggest trust gap on the site — bigger than any technical one.

**[next] Separate shipped from vision on the site**

"Open agent economies" copy sits directly below verified capability sections and undercuts them. Shipped-and-verified gets the product page; the long arc gets its own home (see VISION.md).

---

Recently shipped

---

- **[done]** Rust daemon experiment ended (#1056). One daemon, TypeScript on Bun. The parity harness, shadow proxy, and runtime switch are gone.
- **[done]** Embedding migration without recall downtime (v0.157.x).
- **[done]** Rehearsal boost fix (#972) — session-start injection no longer advances access tracking.
- **[done]** Recall divergence fix (#929) — shared request builder across CLI, MCP, and Pi extension; follow-up #931 for the remaining harnesses.
- **[done]** Public repositioning — README and site language now lead with local-first memory and secrets.
- **[done]** Inference cutover to pi-ai + ACPX (#947 A / #949). All hand-rolled providers deleted, -5,853 lines.
- **[done]** Distribution model spec (#1001). Three install shapes, cloud architecture, locked.
- **[done]** Dashboard redesign HTML mockup — the design spec for the React rewrite.
- **[done]** Connector expansion (Hermes Agent, OpenClaw, Kimi provider PR open).

---

What changed from the last roadmap

Three things. First, the Rust daemon is gone — the experiment produced good data and the answer was no; one daemon means one place bugs live. Second, ops hardening jumped the queue: the backlog death spiral (#1059) and the repair-tooling bugs made clear that reliability work can't keep sitting behind feature work. Third, benchmarks moved from headline to evidence — recall quality is table stakes now; what differentiates Signet is distribution, UX, and the secrets/memory bundle nobody else ships. The long-arc ideas from VISION.md (measured access to personal data, authority artifacts) are unchanged — they're the destination. This roadmap is the next stretch of road.
