# Organization load driver

Run from the repository root after building core and CLI workspace dependencies as described in `tests/integration/org-mode/README.md`.

```sh
export PATH=/home/nicholai/.bun/bin:$PATH
BUN=$(command -v bun)
"$BUN" evals/org-load/run.ts --developers 50 --iterations 20 \
  --session-end-every 5 --think-ms 100 \
  --out /absolute/scratch/path/org-load.json
```

The default is 50 developers, 20 iterations each, a session end every five iterations, and 100 ms think time. `--single` uses organization-agent storage for every developer. Admission is bounded at 2,000 developers and 100,000 developer-iterations. The output directory must already exist. Startup/provisioning errors fail the run; loop request errors are counted and reported, not retried away.

Each developer is invited as a real member, signs in through device approval, obtains a connector key, and independently loops over session-start, prompt-submit recall, remember, and periodic session-end. All clients hit one isolated daemon/DB owner. The fixture disables external inference, embeddings generation, and background Dreaming so this measures the authenticated API/owner path without provider costs; it is not full-stack inference or production capacity certification. The load window begins after provisioning.

The JSON report contains per-route request/error counts, error types, and nearest-rank p50/p95/p99 latency in milliseconds. It also counts HTTP rejection responses by status, the first 512 characters of the server's JSON error message, and `Retry-After`. At most 20 distinct rejection descriptions per route are retained; `rejectionResponsesOmitted` explicitly counts HTTP errors omitted from those descriptions, without dropping them from the request/error totals. Requests use direct HTTP, not a harness connector's transport, and perform no retries. Latencies include unsuccessful requests; error counts must be read with the percentiles. It samples the actual DB-owner `queuedJobs` metric from `/health` once per second, including owner health and sampling errors, and says whether that metric was available. Pipeline job-queue counts are not mislabeled as DB-owner admission depth. Queue sampling is bounded to 3,600 observations. SIGINT/SIGTERM stops new iterations and emits an interrupted report before teardown.

For native-binary measurements:

```sh
SIGNET_DAEMON_BIN=/absolute/path/to/signet-linux-x64 \
  "$BUN" evals/org-load/run.ts --developers 50 --iterations 20 \
  --out /absolute/scratch/path/org-load-native.json
```

The compiled binary must match the checkout's migrations. Compare source and compiled reports separately. No supplied daemon URL is used: the driver always creates its own disposable HOME/workspace and ephemeral port and reaps only its own daemon process group. Never point it at a live organization's workspace.

## Base-branch mechanics control

```sh
"$BUN" evals/org-load/run.ts --baseline --developers 2 --iterations 2 \
  --session-end-every 1 --think-ms 10 \
  --out /absolute/scratch/path/org-load-control.json
```

`--baseline` is an explicitly labeled legacy-team control using real scoped legacy tokens and separate agents, rather than fabricated users or organization API responses. It exercises the same real request loop, timing/reporting, queue sampling, isolation, and teardown on the base branch. Its report is **not organization-mode proof** and cannot substitute for the default 50-user run on the integrated branch.
