# Release channels

Signet ships two user-facing release channels:

| Channel | npm dist-tag | GitHub release state | Intended users |
| --- | --- | --- | --- |
| `stable` | `latest` | normal release | Default channel for normal users who want predictable behavior. |
| `nightly` | `next` | prerelease | Opt-in channel for Signet development, dogfooding, and early validation. |

There is no LTS channel yet. Stable/nightly gives Signet room to move quickly without promising long-term branch support before the project is ready for that maintenance burden.

## Policy

### Nightly

- Built automatically from `main` by `.github/workflows/release.yml`.
- Published to npm with the `next` dist-tag.
- Created as a GitHub prerelease.
- May include experimental defaults, unstable behavior, and day-to-day development churn.
- Must remain opt-in; Signet should not silently move a stable user to nightly.

Install explicitly:

```bash
npm install -g signetai@next

# Direct native installer
curl -fsSL https://signetai.sh/install.sh | SIGNET_CHANNEL=nightly bash
```

The npm package is a wrapper around the same compiled Signet binary published
to the GitHub release for that version.

Or switch an existing install's update checks:

```bash
signet update channel nightly
```

### Stable

- Published by manually running `.github/workflows/promote-release.yml` for a known-good nightly version.
- Promoted to npm `latest`.
- Marked as a normal GitHub release.
- Default for install and update checks.

Install:

```bash
npm install -g signetai

# Direct native installer (stable is the default)
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

Compatibility aliases are accepted when reading config or CLI input:

- `latest` -> `stable`
- `next` -> `nightly`

Channel lookup rules:

- `stable` checks GitHub latest stable release first, then falls back to npm `latest`.
- `nightly` skips GitHub latest and checks npm `next` directly, so it cannot be accidentally pinned back to stable by the GitHub latest endpoint.
- The public direct installer resolves GitHub `releases/latest` for stable and
  npm `next` for nightly. `SIGNET_RELEASE_TAG`, `SIGNET_VERSION`, or the
  existing `VERSION` alias remains an explicit version override.

## Release integrity and trust

Native self-updates validate the selected asset's declared size and SHA-256
digest against `native-manifest.json` from the same versioned GitHub release.
The public direct installer validates the asset's SHA-256 digest against that
manifest. These checks detect incomplete, corrupted, or mismatched downloads,
but do not independently authenticate the manifest. Native release assets and
the manifest are not currently signed.

The current trust anchor is the Signet GitHub Actions release workflow, its
repository release permissions, and HTTPS delivery from GitHub. Artifact
signing or attestations would require a separate trust root and verification
flow; they are not implied by the SHA-256 checks described here.

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
