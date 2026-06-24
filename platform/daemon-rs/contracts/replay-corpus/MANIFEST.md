# Rust Replay Corpus Contract

This directory holds the generated TypeScript daemon replay-corpus inventory and
hand-authored seed fixtures for the Rust daemon replay/shadow work.

Phase 1 intentionally implements only **PASS A: static AST inventory**. Runtime
record-mode capture is documented below as a TODO and is not implemented here.

## Files

```text
platform/daemon-rs/contracts/replay-corpus/
  inventory.json              # generated static inventory of platform/daemon/src/**/*.test.ts
  MANIFEST.md                 # this contract
  cases/
    <case-id>.json            # replay fixture
    <case-id>.seed.sql        # deterministic SQLite seed for that fixture
    <case-id>.files.tar.zst   # optional future workspace/file seed archive
```

Regenerate the static inventory with:

```bash
bun platform/daemon-rs/scripts/generate-rust-replay-corpus.ts
```

## Inventory schema

`inventory.json` is an array. Each item represents a discovered `test(...)` or
`it(...)` case from one of the 167 TypeScript daemon test files.

```ts
type InventoryCase = {
  id: string;
  source: {
    file: string;       // repo-relative TS test path
    testName: string;   // describe chain + test title
    line: number;       // 1-based line of the test/it call
  };
  behavioralFamily: string;
  convertibility: Convertibility;
  manifest?: {
    behavior?: string;              // from parity/03-test-corpus-manifest.md
    parityClassification?: string;  // has-rust-equivalent | needs-port | not-applicable-to-rust
    nearestRustBehavior?: string;
    manifestFamily?: string;
  };
  detected: {
    routeStrings: string[];
    httpCalls: DetectedSignal[];
    dbSeedCalls: DetectedSignal[];
    fileSetup: DetectedSignal[];
    envSetup: DetectedSignal[];
    timerSetup: DetectedSignal[];
    providerMocks: DetectedSignal[];
  };
};

type DetectedSignal = {
  line: number;
  kind: string;
  snippet: string;
};
```

The inventory is intentionally conservative. Static AST extraction identifies
candidate routes, DB setup, filesystem setup, environment setup, timers, and
provider mocks; it does not claim to be executable replay data.

## Fixture JSON schema

A fixture represents one deterministic replay case as `(seed DB/files/env,
request(s), expected response, expected internal state)`. A case may use either a
single top-level `request` or a `steps[]` array for multi-request behavior.

```ts
type ReplayFixture = {
  id: string;
  source: {
    file: string;
    testName: string;
    line: number;
  };
  classification: {
    family: string;
    convertibility: Convertibility;
    tags: string[];
  };
  environment: {
    agentYaml: string;
    env: Record<string, string>;
    clock: string;
    uuidSeed: string;
  };
  seed: {
    schema: "migrations-current";
    sql: string;             // repo-relative to replay-corpus/, usually cases/<id>.seed.sql
    files?: string;          // optional future cases/<id>.files.tar.zst
    redactions: string[];
  };
  request?: ReplayRequest;
  expectedResponse?: ExpectedResponse;
  expectedInternalState?: ExpectedInternalState;
  steps?: ReplayStep[];
  normalization: {
    ignoreColumns: string[];
    sortRowsBy: string[];
    floatTolerance: number;
  };
};

type ReplayStep = {
  name: string;
  request: ReplayRequest;
  expectedResponse: ExpectedResponse;
  expectedInternalState?: ExpectedInternalState;
};

type ReplayRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

type ExpectedResponse = {
  status: number;
  headers?: Record<string, { contains?: string; equals?: string }>;
  json?: unknown;                    // exact JSON when stable
  jsonContains?: unknown;            // partial object match
  jsonMatchers?: Record<string, string>; // JSONPath -> string | number | boolean | array | object | null | absent
  jsonPathAssertions?: Array<{
    path: string;
    contains?: unknown[];
    excludes?: unknown[];
    equals?: unknown;
    count?: number;
  }>;
  ignoreJsonPaths?: string[];
};

type ExpectedInternalState = {
  db: Array<{
    table: string;
    where?: string;
    orderBy?: string[];
    columns?: string[];
    rows?: unknown[][];
    count?: number;
  }>;
  files: Array<{
    path: string;
    exists: boolean;
    sha256?: string;
    contains?: string;
  }>;
};
```

Fixtures must be deterministic and must not contain raw secrets. Use
`seed.redactions`, `ignoreJsonPaths`, and `jsonMatchers` for volatile API keys,
hashes, timestamps, UUIDs, temporary paths, provider vectors, or platform output.

## Convertibility taxonomy

- `http-db`: HTTP/API behavior with stable SQLite seed and post-request DB
  assertions. These should be first-class Rust replay fixtures.
- `http-files`: HTTP/API behavior that also needs workspace files or generated
  file assertions. These need file archive support before full replay.
- `state-only`: DB/helper/algorithm tests without an HTTP request. These can be
  ported to Rust unit/integration tests or later internal-state fixtures.
- `provider-mocked`: Behavior depends on mocked external providers, model
  processes, fetch responses, embeddings, source APIs, or fake provider servers.
  These require provider fixture adapters before replay.
- `runtime-specific`: Behavior depends on watchers, sockets, process lifecycle,
  timers, git, update installers, scheduler workers, JS/Bun runtime semantics, or
  other bespoke harness support.

## PASS B runtime capture TODO (not implemented)

Runtime capture should run selected TypeScript tests under
`SIGNET_REPLAY_CAPTURE=1` with a preload module and produce normalized fixture
JSON/SQL from actual execution. The capture layer should:

1. Wrap Hono/app request entrypoints and global `fetch` to capture request
   method/path/headers/body and response status/headers/body.
2. Wrap DB accessors and migrations to snapshot the migrated baseline, pre-step
   seed rows, and post-step state diffs.
3. Stabilize clocks, UUIDs, randomness, provider output, and temp workspace
   paths.
4. Archive workspace file deltas with redaction for `http-files` cases.
5. Reject generated fixtures containing raw secrets, absolute temp paths,
   unordered row assertions, missing `orderBy`, or uncategorized provider output.

PASS B should produce executable `cases/<case-id>.json` and
`cases/<case-id>.seed.sql` files, but Phase 1 keeps this as documented future
work only.
