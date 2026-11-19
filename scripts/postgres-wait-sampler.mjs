export async function startPostgresWaitSampler(pool, database, { intervalMs = 250, limit = 10000, onSample } = {}) {
  const samples = [], errors = []
  let closed = false, inFlight, dropped = 0, streamed = 0
  const sample = async () => {
    const result = await pool.query(`SELECT pid,application_name,state,wait_event_type,wait_event,
      cardinality(pg_blocking_pids(pid)) AS blockers,
      EXTRACT(EPOCH FROM clock_timestamp()-xact_start)*1000 AS transaction_ms
      FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() ORDER BY pid`, [database])
    // Deliberately omit SQL text, connection strings, usernames and business values.
    const record = { at: new Date().toISOString(), connections: result.rows }
    if (onSample) { await onSample(record); streamed++ }
    if (samples.length < limit) samples.push(record)
    else if (!onSample) dropped++
  }
  const tick = () => {
    if (closed || inFlight) return
    inFlight = sample().catch(error => { errors.push({ at: new Date().toISOString(), code: error.code ?? 'SAMPLING_FAILED' }) }).finally(() => { inFlight = undefined })
  }
  await sample()
  const timer = setInterval(tick, intervalMs); timer.unref()
  return {
    evidence: { samples, errors, intervalMs, limit, get dropped() { return dropped }, get streamed() { return streamed } },
    async stop() { closed = true; clearInterval(timer); await inFlight },
  }
}
