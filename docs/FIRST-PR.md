---
title: "Your First PR"
description: "A step-by-step guide to making your first contribution to Signet."
order: 25
section: "Project"
---

Your First PR
===

This guide walks you through making your first pull request to Signet.
No prior git or GitHub experience required.

If you get stuck at any point, ask in
[Discord](https://discord.gg/pHa5scah9C) or open a
[Discussion](https://github.com/Signet-AI/signetai/discussions).
We are happy to help.

What you'll need
---

- A [GitHub](https://github.com) account
- [Git](https://git-scm.com/downloads) installed on your machine
- [Bun](https://bun.sh) installed (Signet's package manager)
- A code editor (VS Code, neovim, whatever you prefer)

If git is brand new to you, check out the
[Silly Git Guide](https://sillygitguide.nicholai.work/) for a
beginner-friendly introduction to the basics.

Step 1: Fork the repo
---

A "fork" is your own copy of Signet on GitHub. You'll make changes
there, then propose them back to the main project.

1. Go to [github.com/Signet-AI/signetai](https://github.com/Signet-AI/signetai)
2. Click the **Fork** button (top right)
3. GitHub creates a copy under your account

Step 2: Clone your fork
---

This downloads your fork to your machine so you can work on it locally.

```bash
# Replace YOUR-USERNAME with your GitHub username
git clone https://github.com/YOUR-USERNAME/signetai.git
cd signetai
```

Then add the original repo as a remote called "upstream" so you can
stay in sync:

```bash
git remote add upstream https://github.com/Signet-AI/signetai.git
```

Step 3: Install and build
---

```bash
bun install
bun run build
```

If both of those succeed, you're ready to go. If something fails,
ask in Discord and we'll sort it out.

Step 4: Create a branch
---

Never work directly on `main`. Create a branch that describes what
you're doing:

```bash
git checkout -b fix/typo-in-readme
```

Branch naming conventions:
- `fix/short-description` for bug fixes
- `feat/short-description` for new features
- `docs/short-description` for documentation changes
- `refactor/short-description` for code cleanup

Step 5: Make your changes
---

Edit the files you want to change. If this is your very first PR,
pick something small. Good first contributions:

- Fix a typo or clarify wording in docs
- Improve an error message
- Add a missing test case
- Address an open issue labeled `good first issue`

Browse [open issues](https://github.com/Signet-AI/signetai/issues)
for ideas, or bring one of your own.

Step 6: Verify your changes
---

Before committing, make sure nothing is broken:

```bash
bun run build       # does it still build?
bun test            # do the tests pass?
bun run lint        # any lint issues?
bun run typecheck   # any type errors?
```

Fix anything that comes up. If you're unsure about a failure, ask.

Step 7: Commit your changes
---

Stage the files you changed and write a commit message:

```bash
git add path/to/changed-file.ts
git commit -m "fix(docs): correct typo in quickstart guide"
```

We use [conventional commits](https://www.conventionalcommits.org/).
The format is `type(scope): description`. Common types:

| Type | When to use |
|------|-------------|
| `fix` | Bug fix or correction |
| `feat` | New user-facing feature |
| `docs` | Documentation only |
| `refactor` | Code change that doesn't fix a bug or add a feature |
| `test` | Adding or updating tests |
| `chore` | Maintenance, config, tooling |

Keep the message short (under 50 characters for the subject line)
and use present tense ("fix typo" not "fixed typo").

Step 8: Push to your fork
---

```bash
git push origin fix/typo-in-readme
```

If git asks you to set an upstream, just run the command it suggests.

Step 9: Open a pull request
---

1. Go to your fork on GitHub. You should see a banner saying
   "Compare & pull request." Click it.
2. Fill in the PR template:
   - **Title:** short and descriptive, like your commit message
   - **Description:** explain what you changed and why. Link any
     related issues with `Fixes #123` or `Closes #123`.
3. Click **Create pull request**

That's it. A maintainer will review your PR, leave feedback if
anything needs adjusting, and merge it when it's ready.

What happens after you submit
---

- CI runs automatically (build, lint, typecheck, tests). If
  something fails, click the red X to see what went wrong.
- A reviewer may request changes. This is normal and not a
  judgment on you. Push new commits to the same branch and
  the PR updates automatically.
- Once approved and merged, your contribution shows up in the
  git history and you'll be added to the contributors list.

Keeping your fork in sync
---

Before starting new work, pull the latest from upstream:

```bash
git checkout main
git pull upstream main
git push origin main
```

Then create a new branch from the updated main for your next change.

Ways to contribute beyond code
---

Not every contribution is a pull request. These are all valuable:

- **Report bugs:** Open an [issue](https://github.com/Signet-AI/signetai/issues)
  with steps to reproduce
- **Suggest features:** Start a
  [Discussion](https://github.com/Signet-AI/signetai/discussions)
  or open an issue
- **Improve docs:** Typos, unclear sections, missing examples
- **Test and give feedback:** Run Signet and tell us what's
  confusing, broken, or missing
- **Answer questions:** Help others in Discord or Discussions

Every contribution matters. The contributors list tracks merged code,
but the project benefits from all of these.

Questions?
---

- [Discord](https://discord.gg/pHa5scah9C)
- [GitHub Discussions](https://github.com/Signet-AI/signetai/discussions)
- [Silly Git Guide](https://sillygitguide.nicholai.work/) (git basics)
- [Contributing Guide](./CONTRIBUTING.md) (code conventions and project structure)
