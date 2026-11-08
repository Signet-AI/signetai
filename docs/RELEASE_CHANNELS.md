# Release channels

Signet uses deliberate, manual releases. Merging to `main` does not publish a
release, bump a version, or create a tag.

## Versioning

Starting with `1.0.0`, stable releases use SemVer: a major version changes an
incompatible public contract, a minor version adds a feature, and a patch version
fixes behavior or makes compatible maintenance changes. Earlier `0.x` versions
remain in the release history.

The root `package.json` owns the committed release version. A maintainer prepares
one version-and-changelog commit in a PR; automation never commits a version bump
to `main`. Development and check versions exist only in build workspaces:

- If the committed version `X.Y.Z` has not been tagged, a development build is
  `X.Y.Z-next.N`.
- If `vX.Y.Z` already exists, a development build increments the patch first:
  `X.Y.(Z+1)-next.N`.
- A check build is `X.Y.Z-check.N`.

`N` is the Release workflow run number. Re-running the same run retains that
number. Development builds do not consume stable version numbers.

## User channels

The public channel names remain **stable** and **nightly**. These names are also
accepted by `signet update channel` and the installer's `SIGNET_CHANNEL` variable.

| User channel | npm dist-tag | GitHub release |
| --- | --- | --- |
| `stable` | `latest` | Normal release, marked latest |
| `nightly` | `next` | Development prerelease, or the newer stable release |

A stable release advances both `latest` and `next` for each published package.
A development release advances only `next`. Tags move forward in SemVer order:
`1.0.1` replaces `1.0.1-next.5`, but `1.0.2` does not replace `1.1.0-next.3`.
Thus nightly follows stable when no development build is newer. Stable users do
not move to a development prerelease.

Install stable:

```bash
npm install -g signetai
curl -fsSL https://signetai.sh/install.sh | bash
signet update channel stable
```

Opt into nightly:

```bash
npm install -g signetai@next
curl -fsSL https://signetai.sh/install.sh | SIGNET_CHANNEL=nightly bash
signet update channel nightly
```

On Windows x64:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
$env:SIGNET_CHANNEL = "nightly"; iwr -useb https://signetai.sh/install.ps1 | iex
```

The daemon stores the channel in `agent.yaml`:

```yaml
updates:
  auto_install: false
  check_interval: 21600
  channel: stable
```

The compatibility aliases `latest` and `next` resolve to `stable` and `nightly`.
Stable checks GitHub's latest stable release first, then npm `latest`. Nightly
checks npm `next` directly. The direct installer uses GitHub `releases/latest`
for stable and npm `next` for nightly. `SIGNET_RELEASE_TAG`, `SIGNET_VERSION`,
and the existing `VERSION` alias remain explicit version overrides.

## Dispatch channels

The **Release** workflow (`.github/workflows/release.yml`) has one input,
`channel`, and runs only through `workflow_dispatch`:

| Dispatch channel | Result |
| --- | --- |
| `check` (default) | Build, sign, and smoke-test the candidate; publish no release, git tag, or npm package |
| `next` | Build a development prerelease from `main` and advance npm `next` |
| `stable` | Release the committed plain version from `main` and advance npm `latest` and `next` |

`check` runs from any branch and does not run the stable planning checks below
(changelog section, npm ordering, existing releases), so a green check proves
the builds, not that a stable plan will pass.

All build jobs use the same planned commit SHA. Next and check jobs stamp the
resolved version, then install dependencies before building. Native platforms,
desktop packaging, macOS signing and notarization, and runtime acceptance checks
remain release gates. The reusable Desktop Build workflow also supports a manual
unpublished build of its current ref; tags do not trigger desktop builds.
AUR metadata omits the prerelease hyphen in `pkgver` (for example,
`1.0.1next.42`) because Arch forbids hyphens there; download URLs retain the
exact SemVer release version. With the GitHub publish provider, electron-builder
writes `latest*.yml` update files for prerelease versions too, so every channel
has the same asset list. The desktop auto-updater in a development build looks
for `next*.yml` instead, so desktop apps installed from a `next` build do not
auto-update; install a stable build to restore updates.

## Cut a stable release

1. Start a PR branch from current `main`, with release tags fetched.
2. For the first release under this policy, run
   `bun run release:prepare 1.0.0`. For later releases, run
   `bun run release:prepare [version]`. An explicit version must be plain
   `x.y.z` and greater than the committed version. With no argument, conventional
   commit subjects since the last stable tag determine major, minor, or patch.
   Prerelease tags never shorten the changelog or bump range.
3. Review the new `CHANGELOG.md` section, workspace versions, Cargo versions and
   lockfiles. The script runs version sync, changelog generation, and `bun install`.
4. Open a PR titled `chore: release <version>`. Merge the deliberate release
   commit after review and normal checks. Do not push a release tag.
5. Dispatch **Release** on `main` with `channel=check`. Inspect its results.
6. Dispatch **Release** on the same candidate with `channel=stable`.
7. Confirm the workflow succeeds, the public GitHub release has all native and
   desktop assets, and npm dist-tags point to the intended versions:

   ```bash
   npm view signetai dist-tags --json
   gh release view v<version>
   ```

To distribute development work instead, dispatch **Release** with `channel=next`.
No preparation commit is needed for a development build.

## Publication and resume

Planning validates the stable branch, version, changelog section, remote tag,
existing GitHub release, and current npm `latest`. A remote stable tag must name
the exact planned commit. A draft targeting a different commit is rejected with
an instruction to delete the draft; it is not silently reused.

Stable and next runs create or reuse a draft release targeting the planned SHA.
No git tag is created at this stage. All native and desktop jobs finish and
upload to the draft before publication proceeds. The publish job checks every
expected native, desktop, and manifest asset and verifies the merged macOS update
manifest. It builds and stages npm packages and publishes each missing version
with `release-staging`, not a user-facing dist-tag.

Only after those steps does it publish the GitHub release, creating the tag.
Stable is marked normal/latest; next is marked prerelease/not latest. Then it
advances the channel dist-tags and removes its staging tag. The OpenClaw memory
adapter remains optional; its absence does not block the required packages.

Last, a stable release calls the **Docker Image** workflow, which builds
`ghcr.io/signet-ai/signet` from the new tag and moves the image's `latest`,
`X.Y.Z`, `X.Y`, and `X` tags. Development releases publish no image. Docker
publishing no longer runs on tag pushes; if only the Docker job fails, dispatch
**Docker Image** with the released version.

A build or upload failure leaves no new tag and at most a draft release. A later
npm failure can also leave staged npm versions. Re-run the failed jobs to reuse
the run's SHA, version, draft, and already-published npm versions. A fresh stable
dispatch can also resume the same version, but only from the same commit and only
while the release is still a draft. For next, use GitHub's re-run action to
retain the run number; a fresh dispatch has a new prerelease version. Do not
advance `main` and expect it to resume an old draft.

Publication is not a transaction across npm and GitHub. Finalizing the GitHub
release is the last step of the publish job, and moving dist-tags is a separate
`promote` job. Once a release is public, planning and the publish job both refuse
to run for it, so public assets are never rebuilt or replaced. If `promote` fails,
re-run only that job. If npm publishing fails partway, the versions it did publish
keep their `release-staging` tag until a re-run of `publish` succeeds and
`promote` removes it. Dist-tags never move backward through the Release workflow.

## Roll back stable

**Point Stable at Release** (`.github/workflows/promote-release.yml`) is an
explicit stable-pointer override, not development-to-stable promotion. Supply a
plain `x.y.z` version whose required npm packages already exist and whose GitHub
release is public, not a draft. It points each required package's npm `latest`
at that version, includes the optional adapter only if published, verifies the
tags, and marks the GitHub release latest. It does not change npm `next`, rebuild
assets, or publish packages.

This permits rolling the stable pointer back. It does not force already-installed
newer clients to downgrade. Verify the selected release and npm `latest` after
running it.

## Release integrity and trust

Native self-updates validate each selected asset's size and SHA-256 against
`native-manifest.json` from the same release. The direct installer checks the
asset's SHA-256. These checks detect incomplete, corrupted, or mismatched
downloads; they do not independently authenticate the manifest. macOS native
binaries use Developer ID signing, and official macOS desktop builds are signed,
notarized, and checked with Gatekeeper. The native manifest itself is not signed.

The release workflow, repository release permissions, and HTTPS delivery from
GitHub remain the distribution trust boundary. Hash checks are not a substitute
for an independently authenticated manifest.
