---
title: "Notebook Dump - 2026-02-25"
---

# Notebook Dump - 2026-02-25

Captured from Nicholai's notebook review. Mix of bugs, features, ideas,
and directional notes. Items roughly ordered as discussed.

---

## 1. Workspace Migration / Multi-Location Support

**Priority: High | Type: Architecture**

Users who already have customized `.openclaw/`, `.cloudbot/`, or
`.moltbot/` workspaces should NOT be forced to move everything to
`~/.agents/`. Many users have invested serious time customizing theirs
and have backups built around the current location.

We need to support both approaches:
- Keep their existing workspace location as primary
- Signet syncs with it rather than replacing it

**Considerations:**
- Symlinks are unstable and break git
- Daemon file watcher could handle sync, but edge cases are unknown
- Need to research the cleanest bidirectional sync approach
- Possibly a config flag: `workspace_path: ~/.openclaw/` that Signet
  respects as source of truth instead of `~/.agents/`

**Decision:** Config pointer approach (`workspace_path` in agent.yaml).
Daemon reads from wherever the pointer says, writes harness outputs
accordingly. No symlinks, no bidirectional sync headaches. Must:
- Work across all harnesses (claude code, opencode, openclaw, etc.)
- Be idempotent -- not break existing installs
- Default to `~/.agents/` but ask the user during setup
- Handle the skills directory problem (see addendum #21)

**Complication (from addendum):** Custom workspace paths mess up the
skills system because skills install to `~/.agents/skills/` per the
open agent standard. Need to figure out either:
- Skills always install to `~/.agents/skills/` regardless of workspace path
- Skills install relative to the configured workspace path
- Some kind of resolution layer that checks both locations


## 2. Obsidian Vault Integration

**Priority: Medium | Type: Feature**

Two possible approaches:
1. Allow users to connect their agents workspace to an existing
   Obsidian vault (bi-directional or one-way sync)
2. Pre-configure a ready-made Obsidian workspace that comes with
   full-text search and proper structure out of the box

Either way, the goal is letting users browse/search their agent's
memory and files through Obsidian's UI.


## 3. Signet Seal / Logo Design

**Priority: High | Type: Brand**

The logo/seal needs to be designed soon. No current design exists.
Reference brand guidelines in `brand/BRAND.md`.


## 4. Wider Installation Methods + Browser Onboarding

**Priority: High | Type: UX / Onboarding**

Core install should be two commands max:
```
bun add -g signetai   # or npm install -g signetai
signet setup
```

At the point of running `signet setup`, it should ask:
- "Do you want to set up in the **browser** or in the **terminal**?"

Both paths should surface all the important config options -- do NOT
dumb down or hide things from users. But many users are afraid of the
terminal and we'll lose them if we require it.

**Key insight:** After onboarding several users of different skill
levels, terminal-only is a hard gate that filters out a large chunk
of potential users.


## 5. Session Log Accessibility

**Priority: Medium | Type: DX**

Session logs should be easier for agents to look through. Current
format/location makes it harder than it needs to be.


## 6. Core Audience Note

**Type: Vision / Positioning**

Signet's core audience and community is **knowledge-first people**.
We are vision-first, building a community of people who are all
driven and connected to the core vision of Signet. (Phrasing TBD,
but the sentiment is right.)


## 7. Dashboard Task Bugs

**Priority: High | Type: Bug**

- **Editing existing tasks does not work.** You can create them but
  cannot edit or modify them in the dashboard.
- **Tasks don't work with OpenCode.** They should.
- **Tasks need rich logging.** You should be able to click into a task
  and see what the agent is doing -- full run output, not just status.


## 8. Ethereum / Blockchain Direction

**Priority: Medium | Type: Feature / Architecture**

Continue moving Signet toward Ethereum and blockchain integration.
Jake (Busyby 3333) has an open PR that we've been cherry-picking
from. Need to continue that work.


## 9. NPM Install is Broken

**Priority: Critical | Type: Bug**

When installing Signet with `npm install -g signetai`, the CLI
crashes near the end of onboarding because BUN is still a runtime
dependency. Users shouldn't have to install via NPM and then also
need BUN installed -- that's not fair.

**Options:**
1. Fix the NPM install path so BUN is not required at runtime
2. Gate off NPM support entirely for now (preferred short-term) --
   just tell users to use BUN and avoid the broken path
3. At minimum, detect missing BUN early and fail with a clear message
   instead of crashing halfway through onboarding

BUN installs work great. NPM installs are the problem.


## 10. Non-Interactive CLI Mode

**Priority: Critical | Type: Feature**

The CLI is currently **interactive-only**. This means agents literally
cannot use it to help users onboard. The onboarding skill on the
website is great in theory but useless in practice because the agent
can't drive the CLI.

**Needs:**
1. Add a non-interactive mode to the CLI (flags, env vars, or config
   file that pre-fills all prompts)
2. Update the onboarding skill to explain to the agent exactly what
   fields need to be filled out and how to pass them non-interactively
3. Document the non-interactive API clearly


## 11. Onboarding: Drop Timezone Prompt

**Priority: Low | Type: Quick Fix**

The onboarding flow asks the user for their timezone, but the timezone
is already available in the system prompt automatically via Signet.
Remove this step.


## 12. Onboarding Structure / UX Overhaul

**Priority: High | Type: UX**

The onboarding flow lacks structure and users don't know what to
expect. Problems observed:

- Users don't know how many steps/prompts are in the flow
- Users cram all their preferences into a single prompt because they
  think it might be their only chance
- No progress indication or outline of what's coming

**Vision:** The experience should feel like talking to a cyberpunk
black wall gateway -- like you're interfacing with the Signet daemon
itself. Think Cyberpunk 2077's beyond-the-black-wall AI. Signet is
assisting you in designing and configuring your agent.

**Requirements:**
- Show users the full process outline upfront ("Here's what we'll
  cover: 1. Identity, 2. Personality, 3. Preferences, ...")
- Step indicators (e.g., "Step 2 of 6")
- Each step has a clear, focused purpose
- Strictly structured -- don't let the conversation meander


## 13. Onboarding Skill Trust / Agent Transparency

**Priority: High | Type: Security / UX**

Newer versions of Claude Code warn users that skills could be prompt
injections. This is good security practice but it undermines user
trust during Signet installation.

**Needs:**
- The onboarding skill needs to be more transparent about what Signet
  is and what it's doing, so agents trust it enough to proceed
- Same philosophy as our existing approach: be transparent to agents
  that have Signet installed on top of them
- The skill should clearly explain its purpose and scope so the host
  agent doesn't flag it as suspicious
- Stricter skill structure to reduce the surface area that looks
  "injectioney"

## 14. Onboarding UX - Expanded Notes

**Priority: High | Type: UX (expands #4 and #12)**

Onboarding should work in three places:
1. **Dashboard** (browser)
2. **Terminal** (CLI)
3. **Discord** (hand it off to your agent)

All three should be good experiences. The flow MUST run the actual
`/onboarding` skill -- this is non-negotiable. The pre-install
messaging should make clear that the onboarding skill won't be
available until after the base install completes.

**Persona / Tone:**
The guiding presence should feel like the Signet daemon itself --
black wall gateway, cyberpunk aesthetic, but the voice is kind,
feminine, nurturing, refined. Like laying your head on the chest of
someone you love while they run their fingers through your hair. Warm
and safe, but still structured.

**Flow requirements:**
- Outline the full process upfront: "Here's what we'll cover..."
- Step indicators at every stage
- Each step has a single focused purpose
- Teach the user to relax and trust the process
- Users should NOT feel rushed or inclined to cram details
- Give them room to breathe
- Above all else: it should be **easy**


## 15. Remember/Recall Skills - Rethink Exposure

**Priority: High | Type: UX / Architecture**

The `/remember` and `/recall` skills that ship pre-installed should
either:
1. Not be exposed to users by default, OR
2. Be exposed with a clear disclaimer about what they're for

**Problem:** They work, but they are NOT the intended use case of
Signet. Their existence implies they're needed, which is misleading.
Signet's value is in automatic memory -- not manual `/remember` calls.

**Worse:** Because manually added memories get higher importance
scores, users are doing wild stuff like writing hooks that run
`/remember` after every session. This literally doubles token usage
for no benefit since the pipeline already captures everything
automatically.


## 16. Reasonable Defaults - Config Overhaul

**Priority: Critical | Type: Bug / Config**

Users are getting into Signet expecting a good experience and the
defaults are failing them. The following changes need to ship:

### Embeddings
- In the installer flow, only offer **nomic-embed-text** for Ollama
  users. No other local model options.
- OpenAI users can use the small model.
- Clearly warn: changing embedding models requires re-embedding the
  entire database. Not recommended for existing installs.

### agent.yaml Defaults
- `rehearsal`: **enabled** by default. Push this to existing users
  who don't have it enabled.
- `database` and `memory.md` paths: pre-configured, never empty
- **agent.yaml should ship fully filled out** with every available
  option and its default value. Users and agents need to see what's
  available when troubleshooting. Empty fields are unacceptable.
- Need documentation for every config option.

### V2 Memory Pipeline
- **Master switch: ENABLED by default.** Currently ships disabled,
  which means most users aren't getting the core value of Signet.
- Extraction provider: default to **claude code** (or opencode,
  whichever the user is using). NOT ollama/qwen3:4b -- it's not
  good enough. For opencode support, need to load available model
  names or provide an easy selection mechanism.
- `maintenance_mode`: **execute** by default
- `allow_update_delete`: **on**
- `graph_enabled`: **on**
- `autonomous_enabled`: **on**
- `reranker`: **on**


## 17. Dynamic Memory.md Update Frequency

**Priority: Medium | Type: Feature**

On busy days (high agent usage), `memory.md` should be regenerated
more frequently. Currently it updates on a fixed schedule regardless
of activity level. Should scale with usage intensity.


## 18. Sub-Agent Hook Isolation

**Priority: Critical | Type: Bug / Architecture**

Sub-agents should spawn with the `--no-hooks` environment variable
by default. Same goes for the extractor pipeline when using opencode
or claude code as the extraction provider.

**Why:** When hooks are enabled on sub-agents/extractors, we get
infinite loops. This has been "fixed" at least five times and is
likely still occurring. The root cause is that hooks trigger pipeline
runs which trigger hooks which trigger pipeline runs...

The fix needs to be robust and permanent, not another patch.


## 19. Predictive Memory Scorer

**Priority: Medium | Type: Feature**

Already documented in `docs/wip/predictive-memory-scorer.md`. Needs
implementation. (~1.11M parameter model for memory importance scoring.)


## 20. Browser Extensions

**Priority: Medium | Type: Feature**

Need both:
- **Firefox extension**
- **Chrome extension**

Purpose TBD but likely: memory capture from browsing, agent
interaction from browser context, or dashboard quick-access.


## 21. Workspace Path vs Skills Directory (Addendum to #1)

**Priority: High | Type: Architecture**

The custom workspace path feature (#1) has a complication: most agent
skills install directly to `~/.agents/skills/`, which is the open
agent standard location. If a user's workspace is at `~/.openclaw/`,
skills still install to `~/.agents/skills/` and won't be found.

This needs a resolution strategy before implementing #1. See updated
notes in item #1.

---

## Summary by Priority

### Critical
- NPM install broken (#9)
- Non-interactive CLI mode (#10)
- Reasonable defaults / config overhaul (#16)
- Sub-agent hook isolation / infinite loops (#18)

### High
- Workspace migration support (#1, #21)
- Logo design (#3)
- Browser + Discord onboarding (#4, #14)
- Dashboard task bugs (#7)
- Onboarding structure overhaul (#12, #14)
- Onboarding skill transparency (#13)
- Remember/recall skill exposure (#15)

### Medium
- Obsidian integration (#2)
- Session log accessibility (#5)
- Ethereum/blockchain (#8)
- Dynamic memory.md update frequency (#17)
- Predictive memory scorer (#19)
- Browser extensions (#20)

### Low
- Drop timezone prompt (#11)

### Notes (non-actionable)
- Core audience positioning (#6)
