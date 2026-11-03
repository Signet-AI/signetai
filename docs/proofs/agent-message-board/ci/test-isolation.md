# Full-CI failure: bounded isolation investigation

The implementation commit's full-suite check failed in `platform/daemon/src/routes/native-killswitch.test.ts`, test `reports the local fallback as available without touching native`. The historical CI snapshot remains a failure.

## Reproduction

From the repository root:

    bun test --preload ./scripts/hermetic-test-guard.ts platform/daemon/src/routes/health.test.ts platform/daemon/src/routes/native-killswitch.test.ts

The investigation reproduced 20 passing tests and one failing test at the implementation head and at base `309be2adbc23964c13deaf45b3b33e45a1750f04` in a disposable base checkout. The parent also independently reproduced the same head pair failure. The kill-switch file passed when run alone in the investigation.

The pair fails the same named test at its URL-observation assertion (line 36), whereas the full CI failed its availability assertion (line 32). This is evidence of an existing order dependency, not an exact reproduction of every condition in the CI failure.

The following files are byte-unchanged between that base and the implementation pin: `routes/utils.ts`, `routes/health.ts`, `embedding-fetch.ts`, `routes/health.test.ts`, and `routes/native-killswitch.test.ts` under `platform/daemon/src`.

## Candidate mechanism and limits

`checkEmbeddingProvider` keeps a module-level status cache with a 30-second TTL. Its key includes provider, model, base URL, and `warmNative`. The kill-switch test does not clear that cache. A previously cached result is a plausible explanation for both the fast return and the missing fetch in the local pair.

The CI log reports the native test failure before the coding-agent connector test suite starts. No evidence established that connector's OS mock as the cause. Log ordering alone is not instrumentation of every module's initialization order.

The complete preceding CI test sequence was not replayed, and the exact producer of CI's unavailable status was not identified. A broader routes-directory run timed out without useful output. No production repair or weakened assertion was applied to obtain a green result.

## Conclusion

A pre-existing cross-file failure of this test is reproduced, and the involved production/test files are unchanged by the feature. The exact full-CI failure mechanism remains incompletely isolated. This package therefore does not present the baseline as green or claim that all possible interaction with the feature's tests has been excluded.
