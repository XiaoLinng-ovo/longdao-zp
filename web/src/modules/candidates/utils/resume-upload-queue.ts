export type ResumeUploadQueueResult<T, R> =
  | { item: T; ok: true; value: R }
  | { item: T; ok: false; error: unknown }

/**
 * Runs independent uploads through a fixed number of lanes. A failed item is
 * reported without stopping other lanes, and cancellation prevents new starts.
 */
export async function runResumeUploadQueue<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<ResumeUploadQueueResult<T, R>>> {
  const laneCount = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1))
  const results: Array<ResumeUploadQueueResult<T, R>> = []
  let nextIndex = 0

  const runLane = async () => {
    while (!signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      const item = items[index]!
      try {
        results.push({ item, ok: true, value: await worker(item, index) })
      } catch (error) {
        results.push({ item, ok: false, error })
      }
    }
  }

  await Promise.all(Array.from({ length: laneCount }, () => runLane()))
  return results
}
