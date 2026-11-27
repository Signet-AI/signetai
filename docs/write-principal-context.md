# Write authorization is not evidence attribution

Owners: `platform/core/src/write-principal.ts` and the daemon DB-owner protocol.

A scheduled job can preserve a user's evidence authorship while executing
internally. Inferring authorization from `WriteAuthor` would either block those
jobs or let a request bypass admission by losing its author. Keep the admitted
principal separate across the DB-owner boundary; only explicit daemon-owned job
transitions drop that context. A legacy organization principal with no user is
not an internal producer and cannot write to classified destinations.

Evidence deletion triggers need recursive execution on every writable connection,
not only the connection that ran migration 178. Otherwise a purged memory's
copies can leave further copies and citations behind after reopening the database.
`configureEvidencePurgeConnection` owns that connection policy.
