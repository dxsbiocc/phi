/** Matches the main-owned private startup TaskTool semaphore; accepted work is never queued here. */
export const RPC_CHILD_CONCURRENCY_LIMIT = 4
export function assertRpcChildTaskCapacity(
  activeIds: ReadonlySet<string>,
  reserved: number,
  requested: number
): void {
  if (
    !Number.isSafeInteger(reserved) ||
    reserved < 0 ||
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    activeIds.size + reserved + requested > RPC_CHILD_CONCURRENCY_LIMIT
  )
    throw new Error(
      'Phi expert concurrency limit reached (4); wait for an active expert or stop it'
    )
}
