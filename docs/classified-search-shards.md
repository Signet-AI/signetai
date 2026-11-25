# Classified search must use separate corpora

Owner: `platform/core/src/compartment-shards.ts`; schema installation:
`platform/core/src/migrations/177-classifications.ts`; atomic transitions:
`platform/daemon/src/classification-owner.ts`; vector rebuilds:
`platform/daemon/src/embedding-projection-owner.ts`.

A SQL visibility condition on a shared FTS index does not isolate BM25 scores:
hidden documents still change corpus statistics. A join after a shared vec0 KNN
search is also too late: hidden vectors already consumed the global top-k. Both
can change visible ranks and result counts without returning hidden text.

The base indexes therefore contain only unclassified rows. Each nonempty set of
classifications has its own FTS and vector shards. A read searches the base plus
only the compartments the reader can access and merges scores as-is. Never
replace this with a shared index and a final authorization filter. FTS moves use
conditional old/new triggers; each classification batch commits vector moves,
row labels, and derived copies together. Repair and embedding-profile rotation must
preserve the same partition rather than rebuilding every row into the base.

`platform/daemon/src/read-scope.ts` hides matching content immediately while an
apply job is pending or running. Until its batches move those rows, the base
index can still include their BM25 corpus statistics and vec0 top-k candidates.
This temporary ranking-statistics window closes when the job completes; the
steady-state non-interference guarantee does not describe that transition.
If a job exhausts its batch retries after applying an assignment, the read
restriction remains until the classification is retried or removed, rather than
re-exposing unmoved evidence. A failed job no longer holds the agent's queue.
