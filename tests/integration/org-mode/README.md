# Organization-mode real-daemon acceptance

Run from the repository root on Linux with `setsid` and `ps` available. This harness never connects to an existing daemon. Every invocation creates its own HOME, XDG directories, workspace, database, auth secret, and ephemeral loopback port. It verifies `/health` identifies its child PID and workspace, then waits for the DB owner. Teardown signals only the process group it started and checks that both daemon and owner are gone. Port 3850 and the developer's workspace are not used.

## Build and run

```sh
export PATH=/home/nicholai/.bun/bin:$PATH
BUN=$(command -v bun)
"$BUN" install
"$BUN" run build:core
(cd surfaces/cli && "$BUN" run build:workspace-deps)

"$BUN" scripts/run-hermetic-tests.ts tests/integration/org-mode/self.test.ts
"$BUN" scripts/run-hermetic-tests.ts tests/integration/org-mode/acceptance.test.ts
"$BUN" x tsc -p tests/integration/org-mode/tsconfig.json --noEmit
"$BUN" x biome check tests/integration/org-mode evals/org-load
```

These use the same hermetic runner as `bun run test:hermetic`. Calling the pinned executable directly avoids a dependency-local older `bun` taking precedence inside a package script. Check the version printed by the test runner, not just the outer shell.

To test a branch, check it out in a disposable worktree, include this lane's commit, rebuild the workspace dependencies there, and run the commands above. No separate service, external inference provider, or credentials are needed. Tests use their own generated passwords and keys; they do not print secrets.

The baseline `25ae89272` should pass the self-tests and fail acceptance. Missing organization setup fails explicitly at the `POST /api/org/claim` stdout-token prerequisite. AC3 independently demonstrates the old empty-scope acceptance. Do not skip these failures or treat them as acceptance passes.

For a compiled native binary:

```sh
SIGNET_DAEMON_BIN=/absolute/path/to/signet-linux-x64 \
  "$BUN" scripts/run-hermetic-tests.ts tests/integration/org-mode/acceptance.test.ts
```

The binary is invoked directly with `SIGNET_DAEMON_ENTRYPOINT=1`, the same isolated configuration, and the same health/teardown checks. Database initialization still uses the checkout's core migrations, so the binary and checkout must have the same schema. Build the binary using the repository's native build procedure first. Source-daemon success is not evidence of compiled-binary success.

## Fixture and proof boundaries

`fixture.ts` claims the organization and creates Alice, Bob, Carol, Cora, and Audra through invites. Alice and Bob belong to engineering; Carol belongs to HR and is an ordinary member, not compliance. Cora has compliance permission but is outside the HR audience. Audra is an HR-audience admin, paired with the non-audience bootstrap admin for administrative read surfaces; Carol remains the positive control for member-readable surfaces. The fixture obtains CLI sessions through device approval and issues connector keys under those sessions. Project memories and transcripts enter through authenticated remember and lifecycle hook routes. Get-by-id and transcript readback verify capture and author attribution rather than assuming an accepted write was completed.

Native Dreaming capability calls create the HR-cited entity/aspect/claim graph. The same capability helper, including successful same-agent derivation and a rejected foreign citation, is exercised against the base daemon in the self-test. Claims are derived before their source is classified, so fixture setup does not rely on the bootstrap admin bypassing an HR audience. AC5 creates a visible derived claim first, classifies its evidence through the tracked job API, and checks the claim disappears before success and remains hidden after restart. AC6 submits a schema-valid foreign citation and requires a scope-specific rejection, with a successful same-agent control.

For read surfaces whose data normally requires an inference run, `derived-seed.ts` writes explicitly synthetic, fixed derived-read fixtures: summaries, reflection, document/chunk relationship, assertions, community, pass/tool/history/policy rows, and deterministic vector rows. It runs only after the real daemon and DB-owner group have stopped, then restarts that daemon. It uses the HR memory's actual compartment and existing shard; it does not invent organization API responses or report inference quality. This tests reads over persisted content, not Dreaming scheduling, generation quality, or derivation rebuild. The synthetic running-pass row is dated one hour ahead so startup orphan recovery does not remove the active-pass read fixture; it is not a claim that an inference process is running. The managed source is an empty, disabled vault under the disposable root, never a real vault. Runtime fixtures and keys are removed at teardown.

`noninterference.ts` catalogs the actual memory/search, vector, graph/navigation/ontology, sessions, source health, documents, Dreaming, reflection, transcript export, per-user export, MCP, and hook injection routes. It verifies an unchanged baseline, snapshots non-audience members and admins, adds/grows/reclassifies HR-only content and adds HR-cited claims, then snapshots again. It preserves result IDs, scores, order, counts, cursor/has-more fields, evidence timestamps, HTTP status, and ETags. Only named request-volatility fields and the prompt probe's clock are normalized; embedded MCP JSON retains its counts and scores. Hook reads use the supported sessionless request form, so every probe gets full fresh-context injection without consuming session deduplication or creating probe sessions. The self-test repeats both hook reads and requires identical full responses.

Each surface also requires a successful HR-audience content or changed-aggregate control under a credential authorized for that route. Private detail/subresource responses must equal absent-target controls, including stable aspect/dependency counts; aggregate responses must not contain private fixture identifiers. Twelve visible FTS matches and four visible vectors compete with more than twenty closer hidden vector/FTS matches. Bounded top-k reads require nonempty visible controls and retain scores/order; hidden growth adds new embedding IDs rather than only changing unexposed vector metadata. Positive keyword probes use an HR-specific query on the same route to ensure HR content is observable even when a small public-query top-k would legitimately choose only public rows. A missing/empty fixture, denied audience request, missing endpoint, or 5xx is a failure, not a silent pass.

The fixture includes Alice-authored HR-hidden rows as an own-export negative control. The per-user export probe uses each caller's own author ID: the contract forbids Alice from exporting Carol's material even when unclassified. AC9 repeats binding, read isolation, classification propagation/restart, unnamed-speaker attribution, and deactivation with `agentModel=single`; all three users' default writes must actually resolve to `default`.

AC10 builds the CLI and invokes `connect` for each supported harness in a fresh isolated client HOME. It supplies the key through stdin, scans changed files and sampled `ps -eo args` output for the secret and its unique prefix, and checks key-file permissions. The designated credential/key storage directories are allowed to contain their secret; harness configuration, registry metadata, hook commands, and other files are not.

## AC8 eval artifact

AC8 seeds ten fixed Atlas facts across Alice, Bob, Carol, and the engineering agent, runs ten fixed organization-agent recall questions, and writes `results/atlas-recall.json`. The score is required-fact presence in returned recall context, not an LLM answer judge. Quality does not fail the test; request/fixture errors do. Results are generated, ignored artifacts: attach the actual JSON to the integrated PR rather than committing a guessed score. No result on base is expected because organization bootstrap is absent.

## Integration prerequisites

- AC1/2/8/10: organization claim, invites, group/team agents, device approval/token exchange, connector-key issuance, and user lifecycle APIs (contract sections 3 and 7).
- AC3: legacy-team authentication must reject a non-admin empty scope with `401 empty_scope`.
- AC4/5/9: classification audiences, atomic apply jobs, compartment indexes/shards, and the unified read predicate across all cataloged routes (sections 4 and 5).
- AC5/6/7: native Dreaming citation propagation/rejection and credential-bound speaker/person projection. AC7 requests unnamed shared-agent evidence through the native evidence capability and requires two distinct person bindings; a timeout is a failure, not evidence that a pass ran.
- AC10: CLI stdin provisioning and connector migration to protected key storage/registry resolution. Unsupported flags fail by harness name.

Run the complete acceptance suite on the coordinator's integrated branch. A green self-test is only harness-mechanics proof, not organization isolation proof.
