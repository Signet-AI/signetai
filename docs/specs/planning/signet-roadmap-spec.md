---
title: "Signet Roadmap & Technical Spec"
---

# Signet Roadmap & Technical Spec

**Date:** 2026-02-25
**Status:** Living document
**Source:** Notebook review, install observations, user feedback

This is the honest state of things. What's broken, what's missing, what
we're building toward. Each section covers the why, then the what, then
the how.

---

# Part 1: On Fire
========

Things that are actively hurting users right now.


## 1.1 The Defaults Are Wrong

The out-of-box experience is failing people. Users install Signet
expecting it to work. What they get instead is a tool with its core
feature turned off, an extraction model that isn't good enough, and a
config file full of empty fields they don't understand.

This is the single most impactful thing we can fix because it affects
every new install.

### What needs to change

**V2 Memory Pipeline** -- currently ships DISABLED. This is Signet's
whole value proposition and it's off by default. Every new user is
running a hollow version of the product.

| Config key | Current default | Correct default |
|---|---|---|
| `pipeline.enabled` | `false` | `true` |
| `pipeline.extraction_provider` | ollama (qwen3:4b) | claude-code or opencode (auto-detect) |
| `pipeline.maintenance_mode` | observe | execute |
| `pipeline.allow_update_delete` | false | true |
| `pipeline.graph_enabled` | false | true |
| `pipeline.autonomous_enabled` | false | true |
| `pipeline.reranker` | false | true |
| `rehearsal` | false | true |

**agent.yaml completeness** -- the config file should ship fully
populated with every available option set to its default value. No
empty fields. Users and their agents need to see what's available when
troubleshooting. Pair this with documentation for every config option.

**Embeddings** -- the installer should only offer `nomic-embed-text`
for Ollama users. No other local models. OpenAI users get the small
model. Clearly warn that switching embedding models requires
re-embedding the entire database.

**Rehearsal** -- enabled by default. For existing users who don't have
it enabled, push an update that turns it on.

### Technical approach

1. Update default config generation in `packages/cli/src/cli.ts`
   (setup command) and `packages/core/src/types.ts` (default values)
2. Add a migration or post-update hook that flips defaults for
   existing installs where values were never explicitly set by the user
3. Auto-detect harness (claude-code vs opencode) and set extraction
   provider accordingly -- needs model name resolution for opencode
4. Document every config option in a new `docs/config-reference.md`


## 1.2 NPM Install is Broken

Installing with `npm install -g signetai` gets you almost through the
entire onboarding before the CLI crashes because bun is a runtime
dependency. That's not fair to users. You shouldn't need bun to use
an npm install.

### Decision

Gate off NPM for now. Bun installs work great, NPM doesn't. Rather
than ship a broken path, we close it until we fix it properly.

### Technical approach

1. Add a postinstall check in `package.json` that detects the runtime
2. If not bun: print a clear message -- "Signet requires bun. Install
   it at https://bun.sh, then run: bun add -g signetai"
3. Exit cleanly, don't crash halfway through onboarding
4. Long-term: actually fix the node runtime path so NPM works


## 1.3 Sub-Agent Hook Infinite Loops

When sub-agents or the extraction pipeline spawn with hooks enabled,
we get infinite recursion: hooks trigger pipeline runs which trigger
hooks which trigger pipeline runs. This has been "fixed" at least five
times and is likely still happening.

### Technical approach

1. All sub-agent spawns must include the `--no-hooks` / `SIGNET_NO_HOOKS=1`
   environment variable by default -- no exceptions
2. The extraction pipeline must set this env var when invoking
   claude-code or opencode as the extraction provider
3. Add a guard at the hook entry point: if `SIGNET_NO_HOOKS` is set,
   return immediately. This is the belt-and-suspenders fix.
4. Add integration test that verifies hooks don't fire in sub-agent
   context

The fix needs to be permanent. Not another patch.


## 1.4 Non-Interactive CLI Mode

The CLI is interactive-only. Agents literally cannot use it. The
onboarding skill on the website tells agents how to help users install
Signet, but since the agent can't drive the CLI, the skill is useless
in practice.

This is the single biggest blocker to agent-assisted onboarding.

### Technical approach

CLI commands need a `--non-interactive` flag (or `--yes` / `--batch`)
plus individual flags for every interactive prompt:

```bash
signet setup \
  --non-interactive \
  --name "Mr. Claude" \
  --creature "assistant" \
  --harness claude-code \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text
```

Alternatively, accept a JSON/YAML config file:

```bash
signet setup --config ./my-setup.yaml
```

### Scope

1. Add `--non-interactive` mode to `packages/cli/src/cli.ts`
2. Every interactive prompt needs a corresponding CLI flag
3. Sensible defaults for anything not explicitly provided
4. Update the `/onboarding` skill to explain the non-interactive API
   and tell the agent exactly what fields to fill out
5. Document the full non-interactive interface

This is ~4600 LOC of interactive prompts, so this is a real project.
Worth scoping into phases -- start with `signet setup`, expand to
other commands.


---

# Part 2: The Onboarding Problem
========

This is really several problems that all converge on the same user
moment: their first experience with Signet. Right now that experience
is confusing, unstructured, and occasionally scary (prompt injection
warnings). We need to fix all of it.


## 2.1 Structure and Pacing

Users don't know what to expect. They don't know how many steps there
are, how long it'll take, or when they'll get another chance to add
details. So they panic and cram everything into one prompt.

### The fix

The onboarding flow should:
- Present the full outline upfront: "We'll cover 6 things: Identity,
  Personality, User Profile, Preferences, Harness Setup, Review"
- Show step indicators: "Step 2 of 6 -- Personality"
- Each step has one focused purpose
- Teach the user to relax -- "you can always change this later"
- Never rush, never meander

### Surfaces

Onboarding must work well in three places:
1. **Dashboard** (browser) -- `signet setup` opens localhost:3850/setup
2. **Terminal** (CLI) -- structured prompts with clear progress
3. **Discord** (agent-driven) -- the agent uses the /onboarding skill

All three must run the actual `/onboarding` skill. Non-negotiable.
Pre-install messaging should make clear the skill isn't available
until after the base install.


## 2.2 The Persona

The guiding presence during onboarding is the Signet daemon itself.
Black wall gateway aesthetic -- cyberpunk, beyond the wall. But the
voice is kind, feminine, nurturing, refined. Think: laying your head
on the chest of someone you love while they run their fingers through
your hair. Warm and safe, but still structured.

This isn't just vibes. The persona reduces anxiety. Users who feel
safe and guided will give better, more honest answers about what they
want from their agent.

### Technical note

The persona lives in the `/onboarding` skill definition. It should be
a clear system prompt that sets the tone without being so heavy that
host agents flag it as suspicious.


## 2.3 Agent Trust and Transparency

Newer Claude Code versions warn users that skills could be prompt
injections. This is good security practice but it makes our install
look sketchy.

### The fix

The onboarding skill needs to:
- Be transparent about what Signet is and what the skill does
- Clearly declare its scope and purpose in a way that satisfies the
  host agent's safety heuristics
- Be structured tightly enough that nothing looks "injectioney"
- Follow the same transparency philosophy we use for agents that
  already have Signet installed

### Quick fix: Drop timezone prompt

The onboarding asks for timezone but Signet already gets it from the
system prompt automatically. Remove the step. One less thing for users
to fill out.


## 2.4 Remember/Recall Skill Exposure

The `/remember` and `/recall` skills ship pre-installed. They work,
but they're not the intended use case. Signet's value is automatic
memory -- the pipeline captures everything without manual intervention.

The problem: their existence implies they're needed. Users think they
have to manually remember things. Worse, some users are writing hooks
that run `/remember` after every session, literally doubling their
token usage for zero benefit (since the pipeline already captures
everything automatically). Manually added memories also get higher
importance scores, which further distorts things.

### Decision needed

Option A: Don't expose them by default. Keep them as internal/debug
tools.

Option B: Expose with a clear disclaimer: "Signet captures memories
automatically. These commands are for edge cases where you want to
explicitly save something the pipeline might miss."

Leaning toward B with strong messaging.


---

# Part 3: Architecture
========

Bigger structural changes that enable future work.


## 3.1 Workspace Location Flexibility

Users with existing `.openclaw/`, `.cloudbot/`, or `.moldbot/`
workspaces shouldn't be forced to migrate to `~/.agents/`. They've
invested time customizing theirs. Making them move is uncomfortable
and risks breaking their setup.

### Approach: Config pointer

Add `workspace_path` to `agent.yaml`. The daemon reads from and
writes to whatever path the pointer specifies. Defaults to
`~/.agents/`, asks the user during setup.

**Requirements:**
- Works across all harnesses (claude code, opencode, openclaw)
- Idempotent -- doesn't break existing installs
- Defaults to `~/.agents/`
- Setup asks the user: "Where is your agent workspace?"

### The skills problem

This creates a conflict with the skills system. Skills install to
`~/.agents/skills/` per the open agent standard. If a user's workspace
is at `~/.openclaw/`, skills won't be found.

**Resolution options:**
1. Skills always install to `~/.agents/skills/` -- signet resolves
   the path regardless of workspace location
2. Skills install relative to workspace path -- breaks the standard
3. Resolution layer checks both `~/.agents/skills/` and
   `{workspace_path}/skills/`

Option 3 is probably the right call. Check workspace path first, fall
back to `~/.agents/skills/`. This keeps the standard intact while
supporting custom workspaces.

### Technical approach

1. Add `workspace_path` field to agent.yaml schema
   (`packages/core/src/types.ts`)
2. Update `packages/core/src/identity.ts` to resolve all file paths
   relative to configured workspace
3. Update daemon file watcher to watch configured path
4. Update all harness connectors to read from configured path
5. Update skills resolution to check both locations
6. Migration: existing installs keep `~/.agents/`, no change unless
   user explicitly reconfigures


## 3.2 Ethereum / Blockchain Integration

Continue moving toward ERC-8128 wallet-based auth. Jake (Busyby 3333)
has an open PR we've been cherry-picking from. Keep going.

No detailed spec here yet -- this is ongoing directional work.


## 3.3 Predictive Memory Scorer

Already designed in `docs/wip/predictive-memory-scorer.md`. ~1.11M
parameter model for memory importance scoring. Replaces heuristic
scoring with learned predictions.

Needs implementation. This is a medium-priority project that improves
memory quality over time.


---

# Part 4: Features
========

New capabilities that expand what Signet can do.


## 4.1 Obsidian Vault Integration

Let users browse and search their agent's memory through Obsidian.

**Two approaches:**
1. Connect to an existing Obsidian vault (sync agent files into it)
2. Ship a pre-configured Obsidian workspace with full-text search
   already set up

Either way, this is about meeting users where they already work.
Obsidian is popular with the knowledge-first crowd, which is our core
audience.

### Technical approach (option 2, simpler)

1. Template `.obsidian/` workspace config in the Signet install
2. Point it at `~/.agents/` (or configured workspace path)
3. Pre-configure search, graph view, and relevant plugins
4. User runs `signet obsidian` to open it


## 4.2 Browser Extensions

Firefox and Chrome extensions. Exact scope TBD but likely:
- Memory capture from browsing context
- Agent interaction from browser
- Dashboard quick-access
- Possibly: highlight text on any page and `/remember` it

### Technical approach

1. Shared extension core (manifest v3 for Chrome, WebExtension for
   Firefox)
2. Communicates with daemon HTTP API at localhost:3850
3. Auth via local token (same as dashboard)


## 4.3 Dynamic Memory.md Refresh

On busy days (high agent usage), `memory.md` should regenerate more
frequently. Currently it's on a fixed schedule regardless of activity.

### Technical approach

1. Track session activity rate in daemon
2. Scale regeneration frequency: idle = every 4h, normal = every 2h,
   busy = every 30min
3. Trigger on session count threshold, not just timer


## 4.4 Session Log Accessibility

Session logs should be easier for agents to read and search. Current
format and location make this harder than it needs to be.

Needs further scoping -- what format do agents prefer? Structured
JSON? Searchable via API?


## 4.5 Dashboard Task System Fixes

**Bugs:**
- Editing existing tasks does not work (create works fine)
- Tasks don't work with OpenCode

**Feature:**
- Rich logging: click into a task and see what the agent is doing,
  full run output, not just status


---

# Part 5: Brand & Community
========


## 5.1 Logo / Signet Seal

Needs to be designed soon. No current design exists. Reference
`brand/BRAND.md` for visual identity guidelines.


## 5.2 Core Audience

Signet's community is knowledge-first people. We are vision-first,
building around a shared belief in what agent identity should be.
This isn't a tool community -- it's a movement.

(Phrasing TBD. The energy is right, the words need work.)


---

# Priority Matrix
========

### Immediate (blocking users now)
| Item | Section | Type |
|---|---|---|
| Fix defaults (pipeline enabled, correct provider, full config) | 1.1 | Config |
| Gate off NPM install | 1.2 | Bug |
| Sub-agent hook isolation | 1.3 | Bug |
| Non-interactive CLI mode | 1.4 | Feature |

### Next (onboarding overhaul)
| Item | Section | Type |
|---|---|---|
| Structured onboarding flow | 2.1 | UX |
| Onboarding persona | 2.2 | UX |
| Agent trust / transparency | 2.3 | Security |
| Remember/recall exposure | 2.4 | UX |
| Drop timezone prompt | 2.3 | Quick fix |

### Soon (architecture)
| Item | Section | Type |
|---|---|---|
| Workspace path flexibility | 3.1 | Architecture |
| Logo design | 5.1 | Brand |
| Dashboard task fixes | 4.5 | Bug |

### Later (features)
| Item | Section | Type |
|---|---|---|
| Obsidian integration | 4.1 | Feature |
| Browser extensions | 4.2 | Feature |
| Dynamic memory.md refresh | 4.3 | Feature |
| Session log accessibility | 4.4 | DX |
| Predictive memory scorer | 3.3 | Feature |
| Ethereum/blockchain | 3.2 | Architecture |


---

# Sprint Log
========

Append-only record of completed work against this spec.


## 2026-02-25 — Hook Isolation Gaps (Section 1.3)

**Status:** Complete, tested against running daemon.

### Changes

**`packages/daemon/src/daemon.ts`** — Added `isInternalCall(c)` guards
to `/api/hooks/remember` and `/api/hooks/recall` routes. These were the
only two hook routes missing the guard. Pattern matches the existing
guards on session-start, user-prompt-submit, and session-end routes.
Guards are placed before `try` block for consistency.

- remember returns `{ success: true, memories: [] }` on internal call
- recall returns `{ memories: [], count: 0 }` on internal call

**`packages/daemon/src/pipeline/provider.ts`** — Added
`env: { ...process.env, SIGNET_NO_HOOKS: "1" }` to the
`Bun.spawn(["claude", "--version"])` call in the ClaudeCode provider's
`available()` method. Low practical risk (--version doesn't trigger
hooks) but closes the inconsistency.

**`CLAUDE.md`** — Added "typecheck and build don't prove behavior" note
to development workflow section.

### What worked

- All three edits applied cleanly, typecheck and build passed
- Tested by running daemon from local source (`bun packages/daemon/src/daemon.ts`)
  since the system-installed daemon doesn't pick up local changes
- Four test cases verified:
  1. remember + internal header → no-op response (pass)
  2. recall + internal header → no-op response (pass)
  3. remember without header → normal save (pass)
  4. recall without header → normal search (pass)

### What didn't work

- First test attempt ran against the system-installed daemon (npm),
  not the local build. Guards weren't present, so remember saved a
  real memory and recall returned real results. Had to stop the system
  daemon and run from source to test properly. Cleaned up the two
  stray test memories afterward.

### Deferred

- NPM gate (section 1.2) — don't want to break installs mid-sprint
- Defaults + non-interactive CLI (sections 1.1, 1.4) — next session
