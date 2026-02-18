# Skills

Install, manage, and discover agent skills. Skills are packaged instructions that extend what your agent can do.

---

## What Are Skills?

A skill is a directory inside `~/.agents/skills/` containing at minimum a `SKILL.md` file. That file describes what the skill does and how the agent should use it. Skills are markdown — they contain *instructions*, not executable code.

```
~/.agents/skills/
├── remember/
│   └── SKILL.md          # /remember command
├── recall/
│   └── SKILL.md          # /recall command
├── browser-use/
│   └── SKILL.md          # browser automation
└── github/
    └── SKILL.md          # GitHub CLI operations
```

When a harness loads your agent, the installed skills are included in the system prompt (via the `<available_skills>` section in AGENTS.md). The agent reads the relevant SKILL.md and follows its instructions.

---

## CLI Commands

```bash
# List installed skills
signet skill list

# Search the skills.sh registry
signet skill search browser

# Install from skills.sh
signet skill install browser-use

# Show details about a skill
signet skill info browser-use

# Remove a skill
signet skill remove weather

# Update all installed skills
signet skill update

# Update a specific skill
signet skill update github

# Create a new skill (scaffolding)
signet skill create my-tool
```

---

## Built-in Skills

Signet ships with two built-in skills that integrate directly with the memory system:

### `/remember`

Save information to persistent memory. Content is embedded automatically for semantic search.

```
/remember nicholai prefers bun over npm
/remember critical: never push directly to main
/remember [tag1,tag2]: tagged content here
```

Prefixes:
- `critical:` — pins the memory (never decays, always included in session context)
- `[tag1,tag2]:` — adds searchable tags

See [MEMORY.md](./MEMORY.md) for full details.

### `/recall`

Search memories with hybrid semantic + keyword search.

```
/recall coding preferences
/recall signet architecture
/recall what did we decide about auth
```

See [MEMORY.md](./MEMORY.md) for full details.

---

## SKILL.md Format

Skills are defined with YAML frontmatter followed by markdown content.

```markdown
---
name: example-skill
description: Brief description for skill listings
version: 1.0.0
author: username
homepage: https://github.com/user/skill-repo
dependencies:
  bins: [some-cli]            # Required CLI tools
  skills: [other-skill]       # Required other skills
user_invocable: true          # Can be triggered with /skill-name
arg_hint: "<query>"           # Help text for args
builtin: false                # true for Signet built-ins
---

# Skill Name

What this skill does and when to use it.

## Usage

```
/skill-name some argument
```

## Examples

...

## Implementation

Instructions for the agent on how to carry out this skill...
```

The `user_invocable: true` flag means users can trigger the skill with `/skill-name` in their harness. The `builtin: true` flag marks skills that integrate directly with the Signet daemon API (like remember and recall).

---

## skills.sh Integration

[skills.sh](https://skills.sh) is a public registry of agent skills. Signet searches and installs from it via the `npx skills` CLI.

### How install works

1. `signet skill install <name>` calls `npx skills add <name> --global --yes`
2. The skill is installed to `~/.agents/skills/<name>/`
3. The SKILL.md file is parsed for metadata
4. The harness config is updated to include the new skill

### How search works

1. `signet skill search <query>` calls `npx skills search <query>`
2. Results show name, description, and install count
3. Already-installed skills are marked

---

## Dashboard

The dashboard's **Skills** panel provides a UI for everything the CLI does:

- **Installed tab** — lists skills with name, description, version
- **Browse tab** — search skills.sh, install with one click
- **Detail view** — shows the full SKILL.md content

---

## Creating Custom Skills

```bash
signet skill create my-tool
```

This creates `~/.agents/skills/my-tool/SKILL.md` with a starter template. Edit it to describe what the skill does.

### Example: a custom deployment skill

```markdown
---
name: deploy-staging
description: Deploy the current project to staging
version: 0.1.0
author: nicholai
user_invocable: true
arg_hint: "[service-name]"
---

# deploy-staging

Deploys the current project to the staging environment.

## Usage

```
/deploy-staging
/deploy-staging api-service
```

## Implementation

1. Check that you're on a clean git branch (no uncommitted changes)
2. Run `bun run build` to build the project
3. Run the project's deploy script: `./scripts/deploy.sh staging`
4. Report the deployment URL when complete

If there are uncommitted changes, stop and ask the user if they want to commit first.
```

---

## Harness Integration

### Claude Code and OpenCode

An `<available_skills>` section is generated in the AGENTS.md copy for each harness, listing installed skills by name and description. The agent uses this to know which skills are available.

### OpenClaw

Skills are referenced in the `skills.entries` section of the OpenClaw workspace config, pointing to the `~/.agents/skills/` directory.

---

## Security

Skills are markdown files — they're instructions, not code. A skill only does what the agent chooses to do after reading it. However:

- A malicious skill could instruct the agent to do harmful things.
- Only install skills from sources you trust.
- Skill signing and verification is planned for a future release.

---

## Publishing a Skill

To share a skill on skills.sh:

```bash
cd ~/.agents/skills/my-skill
signet skill publish
```

Requirements:
- Valid SKILL.md with required frontmatter (`name`, `description`, `version`, `author`)
- Unique skill name on skills.sh
- skills.sh account (authenticate via `signet auth`)

---

## Versioning

Skills use semver in the `version` frontmatter field. `signet skill update` compares the installed version against the registry and replaces if newer.

User-created skills (no registry source) are never auto-updated.
