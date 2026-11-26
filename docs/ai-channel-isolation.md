# AI execution channel isolation

Execution capacity is separate from credit reservations. Unknown provider outcomes
retain their billing reservation and replay protection, but do not occupy a live
execution permit after their owner exits.

Defaults: two global text slots, one reserved for interactive requests; one global
saved-audio slot and one saved-audio slot per organization. Organization text and
realtime session limits still use the current policy's `maxConcurrent`. Realtime
packets use authenticated gateway session admission, not text or saved-audio slots.
These limits do not bypass credits, daily usage, service access or provider limits.

Question preparation, summary generation and transcript postprocessing are explicitly
classified as background. Other existing text entry points remain interactive.
Background work fails fast on contention and its durable consumer reschedules it.
Interactive admission waits up to approximately three seconds, then reports busy.
Pool acquisition is separately bounded by the database connection timeout.

Permits are PostgreSQL session advisory locks in namespace 1397901641, scoped to
the current database. A dedicated pooled connection is held until dispatch and
billing settlement finish. Normal completion unlocks before returning the client;
connection loss aborts owned fetch calls and PostgreSQL releases its locks. There
is no expiry timer that can free an ongoing provider call's permit.

`AI_TEXT_GLOBAL_CONCURRENT`, `AI_AUDIO_GLOBAL_CONCURRENT` and
`AI_AUDIO_ORG_CONCURRENT` accept integers from 1 through 32. Each participating
pool needs at least text-global + audio-global + 2 connections (default 5).
The normal production default pool size is 10. Restart all participating services
after changing these limits; do not mix different admission settings across nodes.
Pools behind transaction-pooling proxies are unsupported because ownership must
remain bound to the PostgreSQL session.

Realtime busy/transport errors reconnect with jittered exponential delay while
recording continues. Structured permanent access/quota failures require explicit
remediation and manual reconnect. Browser WebSocket handshake failures do not expose
HTTP rejection details and therefore use transport retry behavior. Stop, pause and
dispose prevent scheduled reconnects; recording storage remains independent.

The enterprise billing panel exposes a read-only organization occupancy snapshot;
it is not a queue position or provider health guarantee. Refresh to update it.

Verification:

```powershell
npm --prefix packages/enterprise-ai test
npm --prefix apps/api run build
node scripts/test-execution-isolation.mjs --postgres-bin D:\software\pgsql\bin
```

The PostgreSQL test creates and stops a separate local cluster, runs migrations,
then checks channel isolation, lost-owner cleanup, billing idempotency, refunds,
audio range-union charging and gateway authorization without production writes.

Rollback: deploy the previous immutable release, or set `AI_CHANNEL_ISOLATION=off`
and restart all managed services to restore shared legacy admission. No schema
migration or business balance rewrite is required by this change.
