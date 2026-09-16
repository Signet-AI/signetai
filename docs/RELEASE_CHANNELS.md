# Release channels

Signet ships two user-facing release channels:

| Channel | npm dist-tag | GitHub release state | Intended users |
| --- | --- | --- | --- |
| `stable` | `latest` | normal release | Default channel for normal users who want predictable behavior. |
| `nightly` | `next` | prerelease | Opt-in channel for Signet development, dogfooding, and early validation. |

There is no LTS channel yet. Stable/nightly gives Signet room to move quickly without promising long-term branch support before the project is ready for that maintenance burden.

## Policy

### Nightly

- Built automatically from `main` by `.github/workflows/release.yml` on pushes that contain code changes; release commits are skipped to prevent loops.
- The workflow derives the next version from the highest local/remote version, defaults to a patch bump, and honors the `.bump-level` value `major`, `minor`, or `patch`.
- It runs `scripts/changelog.ts --bump-only`, synchronizes package/workspace/Cargo/lockfile versions with `scripts/version-sync.ts`, generates the versioned changelog section, and commits/tags the result.
- It builds and smoke-tests the workspace, builds native binaries for all supported platforms, generates the connector/daemon asset archives and `native-manifest.json`, and verifies every required asset.
- Published npm packages use the `next` dist-tag. The GitHub release is a prerelease and remains draft until the release finalizer confirms the native and desktop assets.
- A manually supplied `resume_from_tag` resumes an exact validated `vMAJOR.MINOR.PATCH` tag without bumping or retagging.

Install explicitly:

```bash
npm install -g signetai@next

# Direct native installer
curl -fsSL https://signetai.sh/install.sh | SIGNET_CHANNEL=nightly bash
```

On Windows x64:

```powershell
$env:SIGNET_CHANNEL = "nightly"; iwr -useb https://signetai.sh/install.ps1 | iex
```

The npm package is a wrapper around the same compiled Signet binary published to the GitHub release for that version.

Or switch an existing install's update checks:

```bash
signet update channel nightly
```

### Stable

- Promoted manually from a known-good nightly by `.github/workflows/promote-release.yml`; this workflow is the stable release trigger.
- The exact version is promoted to npm `latest` and marked as a normal GitHub release.
- Stable is the default for installation and update checks.

Install:

```bash
npm install -g signetai
curl -fsSL https://signetai.sh/install.sh | bash
```

Or switch back from nightly:

```bash
signet update channel stable
```

## Update behavior

The daemon stores the user-facing channel in `agent.yaml`:

```yaml
updates:
  auto_install: false
  check_interval: 21600
  channel: stable
```

Compatibility aliases are accepted when reading config or CLI input: `latest` → `stable` and `next` → `nightly`.

Channel lookup rules:

- `stable` checks GitHub latest stable release first, then falls back to npm `latest`.
- `nightly` skips GitHub latest and checks npm `next` directly, so it cannot be accidentally pinned back to stable by the GitHub latest endpoint.
- The public direct installer resolves GitHub `releases/latest` for stable and npm `next` for nightly. `SIGNET_RELEASE_TAG`, `SIGNET_VERSION`, or the existing `VERSION` alias remains an explicit version override.

## Release integrity and trust

Native self-updates validate the selected asset's declared size and SHA-256 digest against `native-manifest.json` from the same versioned GitHub release. The public direct installer validates the asset's SHA-256 digest against that manifest. These checks detect incomplete, corrupted, or mismatched downloads, but do not independently authenticate the manifest. Native release assets and the manifest are not currently signed.

The current trust anchor is the Signet GitHub Actions release workflow, its repository release permissions, and HTTPS delivery from GitHub. Artifact signing or attestations would require a separate trust root and verification flow; they are not implied by the SHA-256 checks described here.

## Promotion checklist

Before promoting a nightly to stable:

1. Confirm CI for the nightly release workflow passed.
2. Confirm daemon release assets exist for every supported platform.
3. Confirm the npm package was published under `next`.
4. Confirm the regression sentinel has not reported a blocker.
5. Run the `Promote Release` workflow with the exact version.
6. Verify npm `latest` points to the promoted version:

```bash
npm view signetai dist-tags --json
```
