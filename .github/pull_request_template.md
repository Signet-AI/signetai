## Summary

<!-- What does this PR do and why? Keep it brief. -->


## Changes

<!-- What files/packages were touched? Bullet the key changes. -->

-

## Type

<!-- Check one. -->

- [ ] `feat` — new user-facing feature (bumps minor)
- [ ] `fix` — bug fix
- [ ] `refactor` — restructure without behavior change
- [ ] `chore` — build, deps, config, docs
- [ ] `perf` — performance improvement
- [ ] `test` — test coverage

## Packages affected

<!-- Check all that apply. -->

- [ ] `@signet/core`
- [ ] `@signet/daemon`
- [ ] `@signet/cli` / dashboard
- [ ] `@signet/sdk`
- [ ] `@signet/connector-*`
- [ ] `@signet/web`
- [ ] `predictor`
- [ ] Other: <!-- specify -->

## Screenshots

<!-- Required for any UI changes (dashboard, web, extension). PRs that
     touch the frontend without screenshots will not be merged. -->


## PR Readiness (MANDATORY)

<!-- Derived from AGENTS.md recurring review failures. These checks are
     required and enforced by CI. -->

- [ ] Spec alignment validated (`INDEX.md` + `dependencies.yaml`)
- [ ] Agent scoping verified on all new/changed data queries
- [ ] Input/config validation and bounds checks added
- [ ] Error handling and fallback paths tested (no silent swallow)
- [ ] Security checks applied to admin/mutation endpoints
- [ ] Docs updated for API/spec/status changes
- [ ] Regression tests added for each bug fix
- [ ] Lint/typecheck/tests pass locally


## Migration Notes (if applicable)

<!-- Fill this section only when migrations are touched. -->

- [ ] Migration is idempotent
- [ ] Daemon Rust parity reviewed or explicitly N/A
- [ ] Rollback / compatibility note included in PR description

## Testing

<!-- How did you verify this works? -->

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Tested against running daemon
- [ ] N/A

## AI disclosure

<!-- See AI_POLICY.md for the full policy. The short version:

  Use AI freely, but understand everything you ship. AI is your hands,
  not your brain. Unreviewed AI output will be closed.

  If AI was used, include Assisted-by tags in your commit messages:

    Assisted-by: Claude-Code:claude-opus-4-6
    Assisted-by: Cursor:claude-sonnet-4-5 biome

  If no AI was used, check the box and move on.
-->

- [ ] No AI tools were used in this PR
- [ ] AI tools were used (see `Assisted-by` tags in commits)

## Notes

<!-- Anything reviewers should know — migration impacts, breaking changes, follow-up work. Leave blank if none. -->
